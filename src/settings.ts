import { PluginSettingTab, Setting, type App } from "obsidian";
import type MemantoPlugin from "./main";
import type { ServerMode } from "./server/lifecycle";
import { command } from "./ui/setup-modal";

export interface MemantoSettings {
	/** Vault folder the OKF bundle is synced into. */
	syncFolder: string;
	/** Agent whose estate this vault mirrors. */
	agentId: string;
	/** Overrides the address read from `~/.memanto/config.yaml` when set. */
	baseUrlOverride: string;
	serverMode: ServerMode;
	/** Results per recall in the side pane. */
	recallLimit: number;
	/** Memories per type in an export. The CLI defaults to 25, which is low for a vault. */
	limitPerType: number;
	/** OKF layout: `auto`, `file` or `type`. */
	split: string;
	syncOnStartup: boolean;
	/** Append a provenance line when inserting a memory into a note. */
	citeOnInsert: boolean;
}

export const DEFAULT_SETTINGS: MemantoSettings = {
	syncFolder: "Memanto",
	agentId: "",
	baseUrlOverride: "",
	serverMode: "dedicated",
	recallLimit: 10,
	limitPerType: 200,
	split: "auto",
	syncOnStartup: false,
	citeOnInsert: true,
};

export class MemantoSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: MemantoPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderStatus(containerEl);

		new Setting(containerEl).setName("Vault").setHeading();

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Where synced memories are written. Existing notes you have edited are never overwritten.")
			.addText((text) =>
				text
					.setPlaceholder("Memanto")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim() || DEFAULT_SETTINGS.syncFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Refresh synced notes when Obsidian opens. Off by default, since it runs an export.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Memories per type")
			.setDesc("How many memories of each type an export includes.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.limitPerType))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.limitPerType = Number.isFinite(parsed) && parsed > 0
							? parsed
							: DEFAULT_SETTINGS.limitPerType;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Note layout")
			.setDesc("One note per memory, one note per type, or let Memanto decide by volume.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ auto: "Automatic", file: "One note per memory", type: "One note per type" })
					.setValue(this.plugin.settings.split)
					.onChange(async (value) => {
						this.plugin.settings.split = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Chat").setHeading();

		new Setting(containerEl)
			.setName("Memories per recall")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.recallLimit)
					.onChange(async (value) => {
						this.plugin.settings.recallLimit = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Cite when inserting")
			.setDesc("Append the type, provenance and date under text inserted into a note.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.citeOnInsert).onChange(async (value) => {
					this.plugin.settings.citeOnInsert = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Server").setHeading();

		new Setting(containerEl)
			.setName("Server")
			.setDesc(
				"By default Obsidian runs its own private Memanto server on a free port, starting it when Obsidian opens and stopping it when Obsidian closes. A server you run yourself is never used, started or stopped.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						dedicated: "Private server for Obsidian",
						attach: "Connect to my own server",
					})
					.setValue(this.plugin.settings.serverMode)
					.onChange(async (value) => {
						this.plugin.settings.serverMode = value as ServerMode;
						await this.plugin.saveSettings();
						await this.plugin.refreshEnvironment();
						this.display();
					}),
			);

		if (this.plugin.settings.serverMode !== "attach") {
			this.renderPrivacy(containerEl);
			return;
		}

		new Setting(containerEl)
			.setName("Server address")
			.setDesc("Leave empty to follow ~/.memanto/config.yaml, so the plugin and your terminal agree.")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8000")
					.setValue(this.plugin.settings.baseUrlOverride)
					.onChange(async (value) => {
						this.plugin.settings.baseUrlOverride = value.trim();
						await this.plugin.saveSettings();
						this.plugin.client.reset();
					}),
			);

		this.renderPrivacy(containerEl);
	}

	/** What the plugin found, and the way back to the walkthrough. */
	private renderStatus(container: HTMLElement): void {
		const environment = this.plugin.environment;
		const box = container.createDiv({ cls: "memanto-settings-status" });

		const rows: Array<[string, string]> = [
			["Server", this.describeServer()],
			["Memanto CLI", environment?.binaryPath ?? "Not found on PATH"],
			[
				"API key",
				environment?.hasApiKey
					? "Found in ~/.memanto/.env"
					: environment?.backend === "on-prem"
						? "Not needed (on-prem)"
						: "Not found",
			],
			["Agent", this.plugin.settings.agentId || environment?.activeAgentId || "None selected"],
		];

		for (const [label, value] of rows) {
			const row = box.createDiv({ cls: "memanto-settings-row" });
			row.createSpan({ cls: "memanto-settings-label", text: label });
			row.createSpan({ cls: "memanto-settings-value", text: value });
		}

		new Setting(container)
			.setName("Setup")
			.setDesc("Step-by-step commands to install and configure Memanto.")
			.addButton((button) =>
				button.setButtonText("Open setup steps").onClick(() => this.plugin.openSetup()),
			)
			.addButton((button) =>
				button
					.setButtonText("Re-check")
					.onClick(async () => {
						await this.plugin.refreshEnvironment();
						this.display();
					}),
			);
	}

	private describeServer(): string {
		const environment = this.plugin.environment;
		if (!environment?.serverUp) {
			return this.plugin.lastServerError ?? "Not running";
		}
		const pid = this.plugin.serverPid;
		return pid !== null
			? `Private server at ${environment.baseUrl} (pid ${pid})`
			: `Your server at ${environment.baseUrl}`;
	}

	private renderPrivacy(container: HTMLElement): void {
		new Setting(container).setName("Privacy").setHeading();

		const box = container.createDiv({ cls: "memanto-privacy" });
		box.createEl("p", {
			text: "This plugin talks only to the Memanto server on your machine. It does not install anything, and it never writes your API key into the vault — it is read from ~/.memanto/.env, where the Memanto CLI stored it.",
		});
		box.createEl("p", {
			text: "That local server, in turn, reaches Moorcheh's cloud when you configured the cloud backend. Configure Memanto with the on-prem backend and nothing leaves your machine at all.",
		});
		box.createEl("p", { cls: "memanto-hint", text: "Check which backend is active:" });
		command(box, "memanto config show");
	}
}
