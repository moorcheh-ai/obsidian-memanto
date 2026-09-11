import { parseYaml } from "obsidian";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

/**
 * Everything the plugin can learn about the user's Memanto install without
 * asking them a single question.
 *
 * The ladder is ordered by usefulness: a responding server settles everything,
 * so later rungs only matter when an earlier one came up empty.
 */
export interface Environment {
	/** A server answered `/health` at `baseUrl`. */
	serverUp: boolean;
	baseUrl: string;
	/** A Moorcheh API key was found in `~/.memanto/.env`. */
	hasApiKey: boolean;
	apiKey: string | null;
	/** `~/.memanto/config.yaml` exists and parsed. */
	hasConfig: boolean;
	/** Agent the CLI last activated, used as our default selection. */
	activeAgentId: string | null;
	/** `cloud` or `on-prem`, when the config says. */
	backend: string | null;
	/** Absolute path to the `memanto` executable, when one is on PATH. */
	binaryPath: string | null;
}

export const DEFAULT_PORT = 8000;

/** Where the CLI keeps its state. */
export function memantoHome(): string {
	return join(homedir(), ".memanto");
}

/** The OKF bundle the CLI writes for an agent when no target is given. */
export function defaultExportDir(agentId: string): string {
	return join(memantoHome(), "exports", `${agentId}_okf`);
}

/**
 * Read the Moorcheh API key.
 *
 * The CLI keeps it in `~/.memanto/.env` and loads it with dotenv at run time,
 * so it is generally *not* in the process environment Obsidian inherits. Read
 * the file first and treat the environment as a fallback for anyone who exports
 * the variable themselves.
 *
 * A local server also grants management access to loopback callers with no key
 * at all, so a null here is not necessarily a problem.
 */
export function readApiKey(): string | null {
	const fromEnvironment = process.env.MOORCHEH_API_KEY?.trim();
	if (fromEnvironment) return fromEnvironment;

	const path = join(memantoHome(), ".env");
	if (!existsSync(path)) return null;

	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return null;
	}

	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;
		if (trimmed.slice(0, separator).trim() !== "MOORCHEH_API_KEY") continue;

		const value = trimmed
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		return value || null;
	}
	return null;
}

interface MemantoConfig {
	port: number | null;
	url: string | null;
	activeAgentId: string | null;
	backend: string | null;
}

/**
 * Read `~/.memanto/config.yaml`.
 *
 * The file nests everything under a `memanto:` root, but tolerate a flat file
 * too — a hand-edited config should not break detection.
 */
function readConfig(): MemantoConfig {
	const empty: MemantoConfig = { port: null, url: null, activeAgentId: null, backend: null };
	const path = join(memantoHome(), "config.yaml");
	if (!existsSync(path)) return empty;

	let parsed: Record<string, unknown>;
	try {
		parsed = (parseYaml(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
	} catch {
		return empty;
	}

	const root = (parsed.memanto ?? parsed) as Record<string, unknown>;
	const server = (root.server ?? {}) as Record<string, unknown>;

	return {
		port: typeof server.port === "number" ? server.port : null,
		url: typeof server.url === "string" ? server.url : null,
		activeAgentId: typeof root.active_agent_id === "string" ? root.active_agent_id : null,
		backend: typeof root.backend === "string" ? root.backend : null,
	};
}

/**
 * Resolve the base URL to talk to.
 *
 * An explicit override in settings wins; otherwise follow the CLI's own config
 * so the plugin and the terminal always agree on the port.
 */
export function resolveBaseUrl(override: string): string {
	const trimmed = override.trim();
	if (trimmed) return trimmed.replace(/\/+$/, "");

	const config = readConfig();
	if (config.url) {
		const url = config.url.replace(/\/+$/, "");
		return /^https?:\/\//.test(url) ? url : `http://${url}`;
	}
	return `http://127.0.0.1:${config.port ?? DEFAULT_PORT}`;
}

/**
 * Look for the `memanto` executable on PATH.
 *
 * The plugin never installs it — this only decides whether we can offer to run
 * a sync or start a server, or whether we show the setup steps instead.
 */
export function findBinary(): string | null {
	const path = process.env.PATH;
	if (!path) return null;

	const names =
		process.platform === "win32" ? ["memanto.exe", "memanto.cmd", "memanto.bat"] : ["memanto"];

	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				if (existsSync(candidate)) return candidate;
			} catch {
				// An unreadable PATH entry is not our problem; keep looking.
			}
		}
	}
	return null;
}

/** Run the whole ladder. Cheap enough to call on load and on every re-check. */
export async function detect(
	baseUrlOverride: string,
	probe: (baseUrl: string) => Promise<boolean>,
): Promise<Environment> {
	const config = readConfig();
	const baseUrl = resolveBaseUrl(baseUrlOverride);
	const apiKey = readApiKey();

	return {
		serverUp: await probe(baseUrl),
		baseUrl,
		hasApiKey: apiKey !== null,
		apiKey,
		hasConfig: existsSync(join(memantoHome(), "config.yaml")),
		activeAgentId: config.activeAgentId,
		backend: config.backend,
		binaryPath: findBinary(),
	};
}

/** True when the user still has real setup work in front of them. */
export function needsSetup(environment: Environment): boolean {
	if (environment.serverUp) return false;
	return !environment.binaryPath || !environment.hasConfig;
}
