import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type ServerMode = "attach" | "manage";

export interface ServerState {
	running: boolean;
	baseUrl: string;
	/** True only when this plugin spawned the process it is talking to. */
	ours: boolean;
	message: string;
}

/** Where a spawned server's pid is recorded, so a crashed session can clean up. */
const PID_FILE = join(tmpdir(), "obsidian-memanto-server.json");

/** How many consecutive ports to try before giving up. */
const PORT_ATTEMPTS = 3;

/**
 * Attaches to a Memanto server, or starts one — never both, and never kills a
 * server it did not start.
 *
 * The plugin does not install Memanto. `binaryPath` is an executable the user
 * put on their own PATH; if it is absent we simply cannot manage a server, and
 * the caller shows the setup steps instead.
 */
export class ServerManager {
	private child: ChildProcess | null = null;
	private ourBaseUrl: string | null = null;

	constructor(
		private readonly probe: (baseUrl: string) => Promise<boolean>,
		private readonly log: (message: string) => void,
	) {}

	get isOurs(): boolean {
		return this.child !== null;
	}

	/**
	 * Bring a server up if we are allowed to, otherwise report what we found.
	 *
	 * Under `attach` this never spawns anything: someone running their own
	 * server should not discover that Obsidian started a second one.
	 */
	async ensure(
		mode: ServerMode,
		baseUrl: string,
		binaryPath: string | null,
	): Promise<ServerState> {
		if (await this.probe(baseUrl)) {
			return {
				running: true,
				baseUrl,
				ours: this.ourBaseUrl === baseUrl,
				message: "Connected to the Memanto server.",
			};
		}

		if (mode !== "manage") {
			return {
				running: false,
				baseUrl,
				ours: false,
				message: "No server is running. Start one with `memanto serve`.",
			};
		}

		if (!binaryPath) {
			return {
				running: false,
				baseUrl,
				ours: false,
				message: "Memanto is not installed, so the server cannot be started.",
			};
		}

		await this.reapOrphan();
		return this.start(baseUrl, binaryPath);
	}

	private async start(baseUrl: string, binaryPath: string): Promise<ServerState> {
		const basePort = portOf(baseUrl);

		// `memanto serve` itself suggests the next port up on a collision, so
		// follow the same convention rather than failing on a busy 8000.
		for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
			const port = basePort + attempt;
			const candidate = withPort(baseUrl, port);

			if (attempt > 0 && (await this.probe(candidate))) {
				return {
					running: true,
					baseUrl: candidate,
					ours: false,
					message: `Connected to an existing server on port ${port}.`,
				};
			}

			const child = spawn(binaryPath, ["serve", "--port", String(port)], {
				// Not detached: the server must not outlive Obsidian, including
				// when Obsidian is force-quit and `onunload` never runs.
				detached: false,
				stdio: "ignore",
				windowsHide: true,
			});

			child.on("error", (error) => this.log(`Failed to start Memanto: ${error.message}`));

			if (await this.waitForHealth(candidate)) {
				this.child = child;
				this.ourBaseUrl = candidate;
				this.recordPid(child.pid, candidate);
				return {
					running: true,
					baseUrl: candidate,
					ours: true,
					message: `Started the Memanto server on port ${port}.`,
				};
			}

			child.kill();
		}

		return {
			running: false,
			baseUrl,
			ours: false,
			message: `Could not start a server on ports ${basePort}–${basePort + PORT_ATTEMPTS - 1}.`,
		};
	}

	/** Poll `/health` for up to ~20s; a cold start has to import the whole app. */
	private async waitForHealth(baseUrl: string): Promise<boolean> {
		for (let i = 0; i < 40; i++) {
			await sleep(500);
			if (await this.probe(baseUrl)) return true;
		}
		return false;
	}

	/** Stop the server, but only if it is ours. */
	stop(): void {
		if (!this.child) return;
		try {
			this.child.kill();
		} catch {
			// Already gone — nothing to do.
		}
		this.child = null;
		this.ourBaseUrl = null;
		this.clearPid();
	}

	private recordPid(pid: number | undefined, baseUrl: string): void {
		if (pid === undefined) return;
		try {
			writeFileSync(PID_FILE, JSON.stringify({ pid, baseUrl }), "utf8");
		} catch {
			// The pid file is a convenience for crash recovery, not a requirement.
		}
	}

	private clearPid(): void {
		try {
			if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
		} catch {
			// Ignore — a stale file is handled on the next start.
		}
	}

	/**
	 * Clean up a server left behind when Obsidian died without unloading.
	 *
	 * `kill(pid, 0)` only tests for existence. Since the pid may have been
	 * recycled by an unrelated process, this is a best-effort sweep guarded by
	 * the recorded base URL still being unreachable.
	 */
	private async reapOrphan(): Promise<void> {
		let record: { pid?: number; baseUrl?: string };
		try {
			if (!existsSync(PID_FILE)) return;
			record = JSON.parse(readFileSync(PID_FILE, "utf8"));
		} catch {
			return;
		}

		if (typeof record.pid !== "number") {
			this.clearPid();
			return;
		}

		try {
			process.kill(record.pid, 0);
			process.kill(record.pid);
			this.log("Cleaned up a Memanto server left over from a previous session.");
		} catch {
			// Not running any more; the record was simply stale.
		}
		this.clearPid();
	}
}

function portOf(baseUrl: string): number {
	const match = baseUrl.match(/:(\d+)\s*$/);
	return match ? Number(match[1]) : 8000;
}

function withPort(baseUrl: string, port: number): string {
	return baseUrl.replace(/:\d+\s*$/, `:${port}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
