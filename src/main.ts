import { createHash } from "crypto";
import { addIcon, FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { MemantoClient } from "./api/client";
import {
	detect,
	needsSetup,
	readSessionToken,
	resolveBaseUrl,
	type Environment,
} from "./env/detect";
import { ServerManager } from "./server/lifecycle";
import { DEFAULT_SETTINGS, MemantoSettingTab, type MemantoSettings } from "./settings";
import { NoBundleError, OkfSync } from "./sync/okf";
import { MASCOT_ICON } from "./ui/mascot";
import { SetupModal } from "./ui/setup-modal";
import { MEMANTO_VIEW_TYPE, MemantoView } from "./ui/view";

export type ServerStatus = "checking" | "starting" | "online" | "offline";

export default class MemantoPlugin extends Plugin {
	settings!: MemantoSettings;
	client!: MemantoClient;
	environment: Environment | null = null;
	serverStatus: ServerStatus = "checking";
	/** Why the last start attempt failed, shown in the pane's offline state. */
	lastServerError: string | null = null;

	private servers!: ServerManager;
	private sync!: OkfSync;
	private settingTab!: MemantoSettingTab;
	private refreshing: Promise<Environment> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon("memanto", MASCOT_ICON);

		this.client = new MemantoClient(() => ({
			baseUrl: this.environment?.baseUrl ?? resolveBaseUrl(this.settings.baseUrlOverride),
			apiKey: this.environment?.apiKey ?? null,
			readSessionToken,
		}));

		this.servers = new ServerManager(
			(baseUrl) => this.probe(baseUrl),
			(message) => console.info(`[Memanto] ${message}`),
			this.instanceKey(),
		);
		this.sync = new OkfSync(this.app, this);

		this.registerView(MEMANTO_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MemantoView(leaf, this));
		this.settingTab = new MemantoSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon("memanto", "Open Memanto", () => void this.activateView());

		this.addCommand({
			id: "open-pane",
			name: "Open chat",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "sync-to-vault",
			name: "Sync memories to vault",
			callback: () => void this.syncToVault(),
		});
		this.addCommand({
			id: "start-server",
			name: "Start server",
			callback: () => void this.startServer(),
		});
		this.addCommand({
			id: "open-setup",
			name: "Setup steps",
			callback: () => this.openSetup(),
		});

		// Stop a server we started when Obsidian quits. Three hooks, because none
		// is guaranteed alone: `quit` may not fire, `beforeunload` covers window
		// close, and `onunload` covers disabling the plugin.
		this.registerEvent(this.app.workspace.on("quit", () => this.servers.stop()));
		this.registerDomEvent(window, "beforeunload", () => this.servers.stop());

		// Everything that touches the filesystem or spawns a process waits for the
		// workspace, so plugin load never delays opening the vault.
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload(): void {
		this.servers.stop();
	}

	private async start(): Promise<void> {
		const environment = await this.refreshEnvironment();

		if (needsSetup(environment) && !this.settings.agentId) {
			// First run on a machine without Memanto: show the steps once, rather
			// than leaving an empty pane with no explanation.
			this.openSetup();
		}

		if (this.settings.syncOnStartup && environment.serverUp) {
			await this.syncToVault({ quiet: true });
		}
	}

	/**
	 * Re-run detection and bring the server this plugin talks to up.
	 *
	 * This is the single place the plugin's picture of the world changes, and
	 * concurrent callers share one run instead of racing two server starts.
	 */
	refreshEnvironment(): Promise<Environment> {
		if (!this.refreshing) {
			this.refreshing = this.doRefresh(this.settings.serverMode === "dedicated").finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	/** Explicit user request: retry starting the private server after a failure. */
	async startServer(): Promise<void> {
		if (this.refreshing) await this.refreshing;
		const environment = await this.refreshEnvironment();
		if (!environment.serverUp && this.lastServerError) {
			new Notice(`Memanto: ${this.lastServerError}`, 8000);
		}
	}

	/** Leave "connect to my own server" and let the plugin run a private one. */
	async usePrivateServer(): Promise<void> {
		this.settings.serverMode = "dedicated";
		await this.saveSettings();
		await this.refreshEnvironment();
	}

	/** The private server's pid, when the plugin is running one. */
	get serverPid(): number | null {
		return this.servers?.pid ?? null;
	}

	/**
	 * @param dedicated Use the plugin's own private server. A server the user
	 *   runs themselves is then never used, started or stopped. Otherwise connect
	 *   to the address in `~/.memanto/config.yaml` or the settings override.
	 */
	private async doRefresh(dedicated: boolean): Promise<Environment> {
		this.setServerStatus("checking");
		const environment = await detect(this.settings.baseUrlOverride, (url) => this.probe(url));
		this.environment = environment;

		if (dedicated) {
			// `detect` probed the user's configured server; in dedicated mode that
			// server is deliberately ignored, so the answer comes from ours alone.
			environment.serverUp = false;
			if (!this.servers.baseUrl && environment.binaryPath) this.setServerStatus("starting");

			const state = await this.servers.ensureDedicated(environment.binaryPath);
			if (state.running) {
				environment.serverUp = true;
				environment.baseUrl = state.baseUrl;
				this.lastServerError = null;
			} else {
				environment.baseUrl = "";
				this.lastServerError = environment.binaryPath ? state.message : null;
			}
		} else {
			// Switching to "connect to my own server" retires the private one.
			this.servers.stop();
			this.lastServerError = null;
		}

		this.client.reset();
		this.setServerStatus(environment.serverUp ? "online" : "offline");
		return environment;
	}

	/** Stable per-vault key, so two open vaults never share a private server. */
	private instanceKey(): string {
		const adapter = this.app.vault.adapter;
		const identity =
			adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
		return createHash("sha1").update(identity).digest("hex").slice(0, 12);
	}

	private setServerStatus(status: ServerStatus): void {
		this.serverStatus = status;
		for (const leaf of this.app.workspace.getLeavesOfType(MEMANTO_VIEW_TYPE)) {
			if (leaf.view instanceof MemantoView) leaf.view.onServerStatusChanged();
		}
	}

	/** Liveness probe that never throws, shared by detection and the server manager. */
	private async probe(baseUrl: string): Promise<boolean> {
		return new MemantoClient(() => ({ baseUrl, apiKey: null })).isUp();
	}

	async syncToVault(options: { quiet?: boolean } = {}): Promise<void> {
		const environment = this.environment ?? (await this.refreshEnvironment());
		const agentId = this.settings.agentId || environment.activeAgentId;

		if (!agentId) {
			new Notice("Memanto: choose an agent in the chat pane first.");
			return;
		}

		const notice = options.quiet ? null : new Notice("Memanto: syncing memories…", 0);

		try {
			const result = await this.sync.run({
				agentId,
				folder: this.settings.syncFolder,
				binaryPath: environment.binaryPath,
				limitPerType: this.settings.limitPerType,
				split: this.settings.split,
			});

			notice?.hide();

			const parts = [`${result.created} new`, `${result.updated} updated`];
			if (result.skipped.length > 0) {
				parts.push(`${result.skipped.length} left alone (edited here)`);
			}
			if (result.source === "cache") parts.push("from a cached export");

			new Notice(`Memanto: ${parts.join(", ")} in ${result.folder}.`);
		} catch (error) {
			notice?.hide();
			if (error instanceof NoBundleError) {
				new Notice(
					"Memanto: nothing to sync yet. Open Setup steps to install the CLI, or run `memanto memory sync --okf` once.",
					8000,
				);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Memanto: sync failed — ${message}`, 8000);
		}
	}

	openSetup(): void {
		const show = (environment: Environment) =>
			new SetupModal(this.app, environment, () => this.refreshEnvironment()).open();

		if (this.environment) show(this.environment);
		else void this.refreshEnvironment().then(show);
	}

	openSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		}).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	/** Reveal the pane, reusing an existing leaf rather than stacking duplicates. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(MEMANTO_VIEW_TYPE);

		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: MEMANTO_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<MemantoSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
