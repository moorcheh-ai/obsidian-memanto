import { App, Modal, Notice, Platform } from "obsidian";
import type { Environment } from "../env/detect";

const KEY_CONSOLE_URL = "https://console.moorcheh.ai/api-keys";

interface Step {
	title: string;
	done: boolean;
	body: (container: HTMLElement) => void;
}

/**
 * The setup walkthrough.
 *
 * This plugin deliberately does not install anything. Downloading and running
 * code on the user's behalf is prohibited for community plugins, and it is also
 * the wrong default — Memanto is a tool people run in their own terminal, with
 * their own Python. So every step here is a command to copy, in the order they
 * need to be run, with the steps already satisfied marked done and collapsed to
 * a single line.
 */
export class SetupModal extends Modal {
	constructor(
		app: App,
		private environment: Environment,
		private readonly onRecheck: () => Promise<Environment>,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("memanto-setup");

		contentEl.createEl("h2", { text: "Set up Memanto" });
		this.renderStatus(contentEl);

		const steps = this.buildSteps();
		const list = contentEl.createDiv({ cls: "memanto-steps" });
		steps.forEach((step, index) => this.renderStep(list, step, index + 1));

		const footer = contentEl.createDiv({ cls: "memanto-setup-footer" });
		const recheck = footer.createEl("button", {
			text: "Re-check",
			cls: "mod-cta",
		});
		recheck.addEventListener("click", async () => {
			recheck.disabled = true;
			recheck.setText("Checking…");
			this.environment = await this.onRecheck();
			this.render();
		});

		footer.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	private renderStatus(container: HTMLElement): void {
		const remaining = this.buildSteps().filter((step) => !step.done).length;
		const status = container.createDiv({ cls: "memanto-status" });

		if (remaining === 0) {
			status.addClass("is-ready");
			status.createSpan({ text: "Memanto is ready. Nothing left to do." });
			return;
		}

		status.createSpan({
			text:
				remaining === 1
					? "One step left. Everything else is already in place."
					: `${remaining} steps left. Run them in your terminal, then choose Re-check.`,
		});
	}

	private renderStep(container: HTMLElement, step: Step, number: number): void {
		const element = container.createDiv({ cls: "memanto-step" });
		if (step.done) element.addClass("is-done");

		const header = element.createDiv({ cls: "memanto-step-header" });
		header.createSpan({
			cls: "memanto-step-number",
			text: step.done ? "✓" : String(number),
		});
		header.createSpan({ cls: "memanto-step-title", text: step.title });

		if (step.done) return;
		step.body(element.createDiv({ cls: "memanto-step-body" }));
	}

	private buildSteps(): Step[] {
		const environment = this.environment;
		// On-prem users never obtain a key, so that step is satisfied for them.
		const keySettled = environment.hasApiKey || environment.backend === "on-prem";

		return [
			{
				title: "Install Memanto",
				done: environment.binaryPath !== null,
				body: (container) => {
					container.createEl("p", {
						text: "Memanto is a Python command-line tool. It needs Python 3.11 or newer.",
					});
					command(container, "pip install memanto");

					const details = container.createEl("details");
					details.createEl("summary", { text: "pip isn't the right tool on my machine" });
					command(details, "uv tool install memanto");
					command(details, "pipx install memanto");

					container.createEl("p", {
						cls: "memanto-hint",
						text: "After installing, restart Obsidian so it picks up the updated PATH.",
					});
				},
			},
			{
				title: "Choose a backend",
				done: keySettled,
				body: (container) => {
					container.createEl("p", {
						text: "Memanto runs against a free cloud service or entirely on your own machine. Pick one — you can switch later.",
					});

					const cloud = container.createDiv({ cls: "memanto-option" });
					cloud.createEl("h4", { text: "Cloud" });
					cloud.createEl("p", {
						text: "A free API key, 100,000 operations, no card. Your memories are stored by Moorcheh.",
					});
					const link = cloud.createEl("a", {
						text: "Get a free key at console.moorcheh.ai",
						href: KEY_CONSOLE_URL,
					});
					link.setAttr("target", "_blank");
					link.setAttr("rel", "noopener");

					const local = container.createDiv({ cls: "memanto-option" });
					local.createEl("h4", { text: "On-prem" });
					local.createEl("p", {
						text: "No key and no account. Everything stays on this machine. Requires Docker.",
					});

					container.createEl("p", {
						cls: "memanto-hint",
						text: "You will paste the key — or pick on-prem — during the next step.",
					});
				},
			},
			{
				title: "Configure Memanto",
				done: environment.hasConfig,
				body: (container) => {
					container.createEl("p", {
						text: "Run this and answer the prompts. It asks which backend you chose and stores the key for you.",
					});
					command(container, "memanto");
					container.createEl("p", {
						cls: "memanto-hint",
						text: "This plugin reads that configuration. It never stores your key in the vault.",
					});
				},
			},
			{
				title: "Start the server",
				done: environment.serverUp,
				body: (container) => {
					container.createEl("p", {
						text: `The side pane talks to a local Memanto server at ${environment.baseUrl}. Leave this running in a terminal:`,
					});
					command(container, "memanto serve");
					container.createEl("p", {
						cls: "memanto-hint",
						text: "Or set “Server” to “Start and stop with Obsidian” in the plugin settings, and this plugin will run it for you.",
					});
				},
			},
		];
	}
}

/** A copyable command line. */
export function command(container: HTMLElement, text: string): void {
	const row = container.createDiv({ cls: "memanto-command" });
	row.createEl("code", { text });

	const button = row.createEl("button", { text: "Copy" });
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.setText("Copied");
			button.addClass("is-copied");
			setTimeout(() => {
				button.setText("Copy");
				button.removeClass("is-copied");
			}, 1400);
		} catch {
			new Notice(
				Platform.isMacOS
					? "Could not copy. Select the command and press Cmd+C."
					: "Could not copy. Select the command and press Ctrl+C.",
			);
		}
	});
}
