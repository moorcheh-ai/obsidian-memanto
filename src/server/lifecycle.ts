import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

/**
 * - `dedicated` — the plugin runs its own private `memanto serve` on a free
 *   loopback port, and stops it when Obsidian closes. A server the user runs
 *   themselves (typically on 8000) is never used, started or stopped.
 * - `attach` — connect to the server in `~/.memanto/config.yaml` or the address
 *   override, and never start anything.
 */
export type ServerMode = "dedicated" | "attach";

export interface ServerState {
	running: boolean;
	baseUrl: string;
	pid: number | null;
	message: string;
}

/** A cold `memanto serve` imports the whole app; allow it this long to answer. */
const STARTUP_TIMEOUT_MS = 45_000;

/** Fresh ports to try if another process grabs the one we picked first. */
const LAUNCH_ATTEMPTS = 3;

/**
 * Owns the plugin's private Memanto server.
 *
 * Ownership is tracked by pid rather than by ChildProcess handle, because on
 * Windows `memanto.exe` is a pip launcher that runs the real server as a child
 * `python.exe`. Killing only the launcher would orphan the server and leave the
 * port bound, so stopping always kills the whole process tree.
 */
export class ServerManager {
	private ownedPid: number | null = null;
	private ownedBaseUrl: string | null = null;
	private child: ChildProcess | null = null;
	private readonly pidFile: string;

	/**
	 * @param instanceKey Distinguishes vaults. Each vault window runs its own
	 *   copy of the plugin, and must not adopt or stop another vault's server.
	 */
	constructor(
		private readonly probe: (baseUrl: string) => Promise<boolean>,
		private readonly log: (message: string) => void,
		instanceKey: string,
	) {
		this.pidFile = join(tmpdir(), `obsidian-memanto-${instanceKey}.json`);
	}

	get baseUrl(): string | null {
		return this.ownedBaseUrl;
	}

	get pid(): number | null {
		return this.ownedPid;
	}

	/**
	 * Make sure the private server is running, and return where it is.
	 *
	 * Reuses the server this vault already owns — including one a crashed
	 * session left behind — before ever starting another.
	 */
	async ensureDedicated(binaryPath: string | null): Promise<ServerState> {
		if (this.ownedBaseUrl && this.ownedPid !== null && (await this.probe(this.ownedBaseUrl))) {
			return this.state(true, "The private Memanto server is running.");
		}

		if (this.ownedPid !== null) {
			// We had a server and it stopped answering. Clear it out properly
			// rather than stacking a second process beside a hung one.
			killTree(this.ownedPid);
			this.forget();
		}

		if (await this.adoptFromPreviousSession()) {
			return this.state(true, "Reconnected to the private server from the last session.");
		}

		if (!binaryPath) {
			return {
				running: false,
				baseUrl: "",
				pid: null,
				message: "Memanto is not installed, so the server cannot be started.",
			};
		}

		return this.launchOnFreePort(binaryPath);
	}

	private async launchOnFreePort(binaryPath: string): Promise<ServerState> {
		let lastError = "";

		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			let port: number;
			try {
				port = await freeLoopbackPort();
			} catch (error) {
				lastError = `no free port available (${(error as Error).message})`;
				break;
			}
			const baseUrl = `http://127.0.0.1:${port}`;

			const launched = this.launch(binaryPath, port);
			if (!launched) {
				lastError = "the memanto executable could not be launched";
				break;
			}

			const { child, exited, stderrTail } = launched;
			if (await this.waitForHealth(baseUrl, exited)) {
				this.child = child;
				this.ownedPid = child.pid ?? null;
				this.ownedBaseUrl = baseUrl;
				this.writePidFile();
				this.log(`Started private memanto serve at ${baseUrl} (pid ${child.pid}).`);
				return this.state(true, `Started a private Memanto server on port ${port}.`);
			}

			lastError = lastLine(stderrTail()) || (exited() ? "the server exited during startup" : "the server did not respond in time");
			if (child.pid) killTree(child.pid);
		}

		this.log(`memanto serve failed: ${lastError}`);
		return {
			running: false,
			baseUrl: "",
			pid: null,
			message: `Could not start the Memanto server: ${lastError}`,
		};
	}

	private launch(
		binaryPath: string,
		port: number,
	): { child: ChildProcess; exited: () => boolean; stderrTail: () => string } | null {
		// Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980).
		const needsShell = /\.(cmd|bat)$/i.test(binaryPath);

		let child: ChildProcess;
		try {
			child = spawn(
				needsShell ? `"${binaryPath}"` : binaryPath,
				// Bind loopback explicitly: the CLI default can be 0.0.0.0, and the
				// plugin's server has no business being reachable from the network.
				["serve", "--host", "127.0.0.1", "--port", String(port)],
				{
					shell: needsShell,
					windowsHide: true,
					stdio: ["ignore", "ignore", "pipe"],
					env: {
						...process.env,
						// With no console attached, Python falls back to the ANSI code
						// page on Windows and crashes printing Rich's unicode output.
						PYTHONIOENCODING: "utf-8",
						PYTHONUTF8: "1",
						NO_COLOR: "1",
					},
				},
			);
		} catch (error) {
			this.log(`Failed to launch memanto: ${(error as Error).message}`);
			return null;
		}

		let hasExited = false;
		let tail = "";
		child.on("exit", () => {
			hasExited = true;
		});
		child.on("error", (error) => {
			hasExited = true;
			tail += `\n${error.message}`;
		});
		// Keep draining stderr for the life of the process: uvicorn logs there,
		// and a full, unread pipe would eventually block the server.
		child.stderr?.on("data", (chunk: Buffer) => {
			tail = (tail + chunk.toString()).slice(-4000);
		});

		return { child, exited: () => hasExited, stderrTail: () => tail };
	}

	/** Poll `/health` until it answers, the process dies, or we time out. */
	private async waitForHealth(baseUrl: string, exited: () => boolean): Promise<boolean> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await sleep(400);
			if (await this.probe(baseUrl)) return true;
			if (exited()) return false;
		}
		return false;
	}

	/**
	 * Stop the private server. A server this plugin did not start is never
	 * touched, because we only ever hold the pid of one we launched.
	 *
	 * Synchronous on purpose: this runs from `beforeunload` while Obsidian is
	 * quitting, where an async kill may never get scheduled.
	 */
	stop(): void {
		if (this.ownedPid === null) return;
		const pid = this.ownedPid;
		killTree(pid);
		this.log(`Stopped private memanto serve (pid ${pid}).`);
		this.forget();
	}

	private forget(): void {
		this.ownedPid = null;
		this.ownedBaseUrl = null;
		this.child = null;
		try {
			if (existsSync(this.pidFile)) unlinkSync(this.pidFile);
		} catch {
			// A stale record is re-validated before it is ever acted on.
		}
	}

	private writePidFile(): void {
		try {
			writeFileSync(
				this.pidFile,
				JSON.stringify({ pid: this.ownedPid, baseUrl: this.ownedBaseUrl }),
				"utf8",
			);
		} catch {
			// Only needed to recover after a crash; not fatal if it cannot be written.
		}
	}

	/**
	 * Obsidian was force-quit and never stopped the server it started. If that
	 * process is still ours and still answering, take it back so it is stopped
	 * when this session ends; if it is alive but hung, kill it.
	 */
	private async adoptFromPreviousSession(): Promise<boolean> {
		let record: { pid?: unknown; baseUrl?: unknown };
		try {
			if (!existsSync(this.pidFile)) return false;
			record = JSON.parse(readFileSync(this.pidFile, "utf8"));
		} catch {
			return false;
		}

		const { pid, baseUrl } = record;
		if (typeof pid !== "number" || typeof baseUrl !== "string" || !isMemantoProcess(pid)) {
			this.forget();
			return false;
		}

		if (await this.probe(baseUrl)) {
			this.ownedPid = pid;
			this.ownedBaseUrl = baseUrl;
			this.log(`Adopted private memanto serve from a previous session (pid ${pid}).`);
			return true;
		}

		killTree(pid);
		this.log(`Cleaned up an unresponsive private memanto serve (pid ${pid}).`);
		this.forget();
		return false;
	}

	private state(running: boolean, message: string): ServerState {
		return { running, baseUrl: this.ownedBaseUrl ?? "", pid: this.ownedPid, message };
	}
}

/** Ask the OS for a free port on loopback. */
function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
		});
	});
}

/**
 * Confirm a pid still belongs to a Memanto server before acting on it. Pids are
 * recycled, and killing an unrelated process because a temp file said so would
 * be unforgivable.
 */
function isMemantoProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}

	try {
		if (process.platform === "win32") {
			const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
				windowsHide: true,
				encoding: "utf8",
				timeout: 5000,
			});
			return /memanto|python/i.test(result.stdout ?? "");
		}
		const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			timeout: 5000,
		});
		return /memanto/i.test(result.stdout ?? "");
	} catch {
		return false;
	}
}

/** Kill a process and everything it spawned. */
function killTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				windowsHide: true,
				timeout: 5000,
			});
		} else {
			process.kill(pid, "SIGTERM");
		}
	} catch {
		// Already gone.
	}
}

function lastLine(text: string): string {
	const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
	return lines.length ? lines[lines.length - 1].trim() : "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
