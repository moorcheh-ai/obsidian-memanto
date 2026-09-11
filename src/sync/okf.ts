import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, posix, relative, sep } from "path";
import { normalizePath, Notice, type App, type Plugin } from "obsidian";
import { defaultExportDir } from "../env/detect";

export interface SyncResult {
	created: number;
	updated: number;
	unchanged: number;
	/** Notes the user edited by hand since the last sync. Left untouched. */
	skipped: string[];
	folder: string;
	source: "fresh" | "cache";
}

/** Raised when there is no bundle to sync and no way to produce one. */
export class NoBundleError extends Error {
	constructor(readonly agentId: string) {
		super(`No OKF bundle found for "${agentId}" and Memanto is not on PATH.`);
		this.name = "NoBundleError";
	}
}

interface ManifestEntry {
	/** Hash of the content this plugin last wrote to that path. */
	hash: string;
	syncedAt: string;
}

type Manifest = Record<string, ManifestEntry>;

const MANIFEST_FILE = "sync-manifest.json";

/**
 * Copies a Memanto OKF bundle into the vault as ordinary Markdown notes.
 *
 * The bundle is already Obsidian-shaped — one note per memory, YAML frontmatter
 * carrying `type`, `tags` and an `x_memanto` block with confidence, provenance
 * and status — so nothing here transforms content. It only moves files in and
 * refuses to overwrite anything the reader has since edited.
 *
 * Notes are written through the Vault API rather than straight to disk so that
 * Obsidian indexes, links and searches them immediately.
 */
export class OkfSync {
	constructor(
		private readonly app: App,
		private readonly plugin: Plugin,
	) {}

	/**
	 * @param binaryPath `memanto` on PATH, or null to reuse whatever bundle
	 *   already exists on disk. The plugin never installs the CLI.
	 */
	async run(options: {
		agentId: string;
		folder: string;
		binaryPath: string | null;
		limitPerType: number;
		split: string;
	}): Promise<SyncResult> {
		const { bundleDir, source } = await this.locateBundle(options);
		const files = collectMarkdown(bundleDir);
		if (files.length === 0) throw new NoBundleError(options.agentId);

		const folder = normalizePath(options.folder);
		const manifest = await this.readManifest();
		const result: SyncResult = {
			created: 0,
			updated: 0,
			unchanged: 0,
			skipped: [],
			folder,
			source,
		};

		for (const file of files) {
			const relativePath = relative(bundleDir, file).split(sep).join(posix.sep);
			const target = normalizePath(`${folder}/${relativePath}`);
			const content = readFileSync(file, "utf8");
			await this.writeNote(target, content, manifest, result);
		}

		await this.writeManifest(manifest);
		return result;
	}

	/**
	 * Write one note, unless the reader owns it now.
	 *
	 * A file whose current content does not match what we last wrote has been
	 * edited by hand. Overwriting it would silently destroy that edit, so it is
	 * skipped and reported by name instead.
	 */
	private async writeNote(
		target: string,
		content: string,
		manifest: Manifest,
		result: SyncResult,
	): Promise<void> {
		const vault = this.app.vault;
		const incoming = hash(content);
		const existing = vault.getFileByPath(target);

		if (!existing) {
			await this.ensureFolder(target);
			await vault.create(target, content);
			manifest[target] = { hash: incoming, syncedAt: new Date().toISOString() };
			result.created++;
			return;
		}

		const current = await vault.read(existing);
		const currentHash = hash(current);

		if (currentHash === incoming) {
			manifest[target] = { hash: incoming, syncedAt: new Date().toISOString() };
			result.unchanged++;
			return;
		}

		const previous = manifest[target];
		if (previous && previous.hash !== currentHash) {
			result.skipped.push(target);
			return;
		}

		await vault.modify(existing, content);
		manifest[target] = { hash: incoming, syncedAt: new Date().toISOString() };
		result.updated++;
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join("/");
			if (!path) continue;
			if (this.app.vault.getFolderByPath(path)) continue;
			try {
				await this.app.vault.createFolder(path);
			} catch {
				// Created concurrently by another iteration — harmless.
			}
		}
	}

	/**
	 * Produce a bundle to copy from.
	 *
	 * Prefer a fresh export via the user's own CLI. When that is unavailable,
	 * fall back to the last bundle the CLI wrote, clearly labelled as cached so
	 * the caller can say the notes may be out of date.
	 */
	private async locateBundle(options: {
		agentId: string;
		binaryPath: string | null;
		limitPerType: number;
		split: string;
	}): Promise<{ bundleDir: string; source: "fresh" | "cache" }> {
		if (options.binaryPath) {
			const staging = join(tmpdir(), "obsidian-memanto", safeName(options.agentId));
			try {
				await runCli(options.binaryPath, [
					"memory",
					"sync",
					"--okf",
					"--project-dir",
					staging,
					"--agent",
					options.agentId,
					"--limit",
					String(options.limitPerType),
					"--split",
					options.split,
				]);
				const produced = join(staging, "okf");
				if (existsSync(produced)) return { bundleDir: produced, source: "fresh" };
			} catch (error) {
				// A failed export is not fatal while a previous bundle survives.
				new Notice(`Memanto export failed, looking for a cached bundle.`);
			}
		}

		const cached = defaultExportDir(options.agentId);
		if (existsSync(cached)) return { bundleDir: cached, source: "cache" };
		throw new NoBundleError(options.agentId);
	}

	private manifestPath(): string {
		return normalizePath(`${this.plugin.manifest.dir}/${MANIFEST_FILE}`);
	}

	private async readManifest(): Promise<Manifest> {
		try {
			const raw = await this.app.vault.adapter.read(this.manifestPath());
			return JSON.parse(raw) as Manifest;
		} catch {
			return {};
		}
	}

	private async writeManifest(manifest: Manifest): Promise<void> {
		try {
			await this.app.vault.adapter.write(this.manifestPath(), JSON.stringify(manifest, null, 2));
		} catch {
			// Losing the manifest costs edit-protection on the next run, not data.
		}
	}
}

/** Every `.md` file in the bundle, depth-first. */
function collectMarkdown(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let stats;
			try {
				stats = statSync(full);
			} catch {
				continue;
			}
			if (stats.isDirectory()) walk(full);
			else if (entry.toLowerCase().endsWith(".md")) found.push(full);
		}
	};
	walk(root);
	return found;
}

function hash(content: string): string {
	// Normalise line endings so a Windows checkout does not look like an edit.
	return createHash("sha1").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function runCli(binaryPath: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		// Node refuses to run .cmd/.bat without a shell (CVE-2024-27980).
		const needsShell = /\.(cmd|bat)$/i.test(binaryPath);
		execFile(
			needsShell ? `"${binaryPath}"` : binaryPath,
			args,
			{
				timeout: 180_000,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
				shell: needsShell,
				// Without a console, Python on Windows falls back to the ANSI code
				// page and crashes printing the CLI's unicode output.
				env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", NO_COLOR: "1" },
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(stderr?.toString().trim() || error.message));
				else resolve(stdout?.toString() ?? "");
			},
		);
	});
}
