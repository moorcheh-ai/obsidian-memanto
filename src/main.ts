import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { MemantoClient } from "./api/client";
import { detect, needsSetup, resolveBaseUrl, type Environment } from "./env/detect";
import { ServerManager } from "./server/lifecycle";
import { DEFAULT_SETTINGS, MemantoSettingTab, type MemantoSettings } from "./settings";
import { NoBundleError, OkfSync } from "./sync/okf";
import { SetupModal } from "./ui/setup-modal";
import { MEMANTO_VIEW_TYPE, MemantoView } from "./ui/view";

export default class MemantoPlugin extends Plugin {
	settings!: MemantoSettings;
	client!: MemantoClient;
	environment: Environment | null = null;

	private servers!: ServerManager;
	private sync!: OkfSync;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.client = new MemantoClient(() => ({
			baseUrl: this.environment?.baseUrl ?? resolveBaseUrl(this.settings.baseUrlOverride),
			apiKey: this.environment?.apiKey ?? null,
		}));

		this.servers = new ServerManager(
			(baseUrl) => this.probe(baseUrl),
			(message) => console.info(`[Memanto] ${message}`),
		);
		this.sync = new OkfSync(this.app, this);

		this.registerView(MEMANTO_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MemantoView(leaf, this));
		this.addSettingTab(new MemantoSettingTab(this.app, this));

		this.addRibbonIcon("brain-circuit", "Memanto", () => void this.activateView());

		this.addCommand({
			id: "open-pane",
			name: "Open side pane",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "sync-to-vault",
			name: "Sync memories to vault",
			callback: () => void this.syncToVault(),
		});

		this.addCommand({
			id: "open-setup",
			name: "Setup steps",
			callback: () => this.openSetup(),
		});

		// Defer everything that touches the filesystem or spawns a process until
		// the workspace is ready, so plugin load never delays vault startup.
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload(): void {
		// Only ever stops a server this plugin started.
		this.servers.stop();
	}

	private async start(): Promise<void> {
		await this.refreshEnvironment();

		if (this.environment && needsSetup(this.environment) && !this.settings.agentId) {
			// First run on a machine without Memanto: show the steps once, rather
			// than leaving an empty pane with no explanation.
			this.openSetup();
		}

		if (this.settings.syncOnStartup) await this.syncToVault({ quiet: true });
	}

	/**
	 * Re-run detection, then bring up a server if the user asked us to manage one.
	 *
	 * Everything downstream reads `this.environment`, so this is the single place
	 * where the plugin's picture of the world changes.
	 */
	async refreshEnvironment(): Promise<Environment> {
		const environment = await detect(this.settings.baseUrlOverride, (url) => this.probe(url));

		if (!environment.serverUp && this.settings.serverMode === "manage") {
			const state = await this.servers.ensure(
				"manage",
				environment.baseUrl,
				environment.binaryPath,
			);
			if (state.running) {
				environment.serverUp = true;
				environment.baseUrl = state.baseUrl;
				new Notice(`Memanto: ${state.message}`);
			}
		}

		this.environment = environment;
		this.client.reset();
		return environment;
	}

	/** Liveness probe that never throws, for both detection and the server manager. */
	private async probe(baseUrl: string): Promise<boolean> {
		const probeClient = new MemantoClient(() => ({ baseUrl, apiKey: null }));
		return probeClient.isUp();
	}

	async syncToVault(options: { quiet?: boolean } = {}): Promise<void> {
		const environment = this.environment ?? (await this.refreshEnvironment());
		const agentId = this.settings.agentId || environment.activeAgentId;

		if (!agentId) {
			new Notice("Memanto: choose an agent in the side pane first.");
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
				console.info("[Memanto] Skipped edited notes:", result.skipped);
			}
			if (result.source === "cache") parts.push("from a cached export");

			new Notice(`Memanto: ${parts.join(", ")}.`);
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
		const environment = this.environment;
		if (!environment) return;
		new SetupModal(this.app, environment, () => this.refreshEnvironment()).open();
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
