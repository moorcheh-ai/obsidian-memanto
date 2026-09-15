import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";
import { MemantoApiError, MemantoOfflineError } from "../api/client";
import { MEMORY_TYPES, memoryText, type AgentInfo, type MemoryItem } from "../types";
import type MemantoPlugin from "../main";
import { createMascot, setMascotState, type MascotState } from "./mascot";

export const MEMANTO_VIEW_TYPE = "memanto-view";

type Mode = "recall" | "answer";
type Temporal = "search" | "recent" | "as-of" | "changed-since";

interface Suggestion {
	label: string;
	run: () => void;
}

/**
 * The side pane, as a conversation.
 *
 * Recall and Answer stay distinct modes, and every reply is labelled with the
 * mode that produced it: a ranked list of stored memories and a synthesised
 * answer are different kinds of evidence, and a chat transcript that mixed them
 * unlabelled would hide which one the reader is looking at.
 *
 * The transcript lives in the DOM and survives mode switches, agent switches
 * and the server going away; only "Clear" empties it.
 */
export class MemantoView extends ItemView {
	private mode: Mode = "recall";
	private temporal: Temporal = "search";
	private selectedTypes = new Set<string>();
	private agents: AgentInfo[] = [];
	private busy = false;
	private messageCount = 0;
	private loadedAgentsFor: string | null = null;

	private headerMascot!: HTMLElement;
	private statusPill!: HTMLElement;
	private agentSelect!: HTMLSelectElement;
	private threadEl!: HTMLElement;
	private panelEl: HTMLElement | null = null;
	private toggleEl!: HTMLElement;
	private optionsEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private dateInput: HTMLInputElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MemantoPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return MEMANTO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Memanto";
	}

	getIcon(): string {
		return "memanto";
	}

	async onOpen(): Promise<void> {
		this.build();
		this.onServerStatusChanged();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	// ================================================================ layout

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("memanto-pane");

		this.buildHeader(root.createDiv({ cls: "memanto-header" }));
		this.threadEl = root.createDiv({ cls: "memanto-thread" });
		this.buildComposer(root.createDiv({ cls: "memanto-composer" }));
	}

	private buildHeader(header: HTMLElement): void {
		const top = header.createDiv({ cls: "memanto-header-top" });

		const brand = top.createDiv({ cls: "memanto-brand" });
		this.headerMascot = createMascot(brand, "idle", "is-small");
		brand.createSpan({ cls: "memanto-wordmark", text: "Memanto" });
		this.statusPill = brand.createDiv({ cls: "memanto-status-pill" });

		const actions = top.createDiv({ cls: "memanto-header-actions" });
		this.iconButton(actions, "folder-sync", "Sync memories to vault", () =>
			void this.plugin.syncToVault(),
		);
		this.iconButton(actions, "eraser", "Clear conversation", () => this.clearThread());
		this.iconButton(actions, "settings", "Memanto settings", () => this.plugin.openSettings());

		const agentRow = header.createDiv({ cls: "memanto-agent-row" });
		const agentIcon = agentRow.createSpan({ cls: "memanto-agent-icon" });
		setIcon(agentIcon, "bot");
		this.agentSelect = agentRow.createEl("select", { cls: "dropdown memanto-agent" });
		this.agentSelect.id = "memanto-agent-select";
		this.agentSelect.addEventListener("change", () => {
			this.plugin.settings.agentId = this.agentSelect.value;
			void this.plugin.saveSettings();
			if (this.messageCount > 0) this.addDivider(`Now asking ${this.agentSelect.value}`);
		});
	}

	private buildComposer(composer: HTMLElement): void {
		this.toggleEl = composer.createDiv({ cls: "memanto-toggle" });
		this.toggleEl.setAttr("role", "tablist");
		this.toggleEl.createDiv({ cls: "memanto-toggle-thumb" });

		const modes: Array<[Mode, string, string, string]> = [
			["recall", "Recall", "search", "Find stored memories"],
			["answer", "Answer", "sparkles", "Get a grounded answer"],
		];
		for (const [mode, label, icon, hint] of modes) {
			const button = this.toggleEl.createEl("button", { cls: "memanto-toggle-option" });
			button.setAttr("role", "tab");
			button.setAttr("data-mode", mode);
			button.setAttr("aria-label", hint);
			setIcon(button.createSpan({ cls: "memanto-toggle-icon" }), icon);
			button.createSpan({ text: label });
			button.addEventListener("click", () => this.setMode(mode));
		}

		this.optionsEl = composer.createDiv({ cls: "memanto-options" });

		const box = composer.createDiv({ cls: "memanto-input-box" });
		this.inputEl = box.createEl("textarea", { cls: "memanto-input" });
		this.inputEl.id = "memanto-chat-input";
		this.inputEl.rows = 1;
		this.inputEl.addEventListener("input", () => this.autoGrow());
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				void this.submit();
			}
		});

		this.sendButton = box.createEl("button", { cls: "memanto-send" });
		this.sendButton.setAttr("aria-label", "Send");
		setIcon(this.sendButton, "arrow-up");
		this.sendButton.addEventListener("click", () => void this.submit());

		composer.createDiv({
			cls: "memanto-composer-hint",
			text: "Enter to send · Shift+Enter for a new line",
		});

		this.setMode(this.mode);
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "memanto-icon-button clickable-icon" });
		button.setAttr("aria-label", label);
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	// ============================================================ mode & options

	private setMode(mode: Mode): void {
		this.mode = mode;
		this.toggleEl.setAttr("data-active", mode);
		this.toggleEl.querySelectorAll<HTMLElement>(".memanto-toggle-option").forEach((option) => {
			const active = option.getAttr("data-mode") === mode;
			option.toggleClass("is-active", active);
			option.setAttr("aria-selected", String(active));
		});
		this.renderOptions();
		this.updatePlaceholder();
		if (this.messageCount === 0 && this.plugin.serverStatus === "online") this.showWelcome();
	}

	private renderOptions(): void {
		this.optionsEl.empty();
		this.dateInput = null;
		this.optionsEl.toggleClass("is-hidden", this.mode !== "recall");
		if (this.mode !== "recall") return;

		const temporal = this.optionsEl.createEl("select", { cls: "dropdown memanto-temporal" });
		temporal.id = "memanto-temporal-select";
		const choices: Array<[Temporal, string]> = [
			["search", "Search"],
			["recent", "Most recent"],
			["as-of", "As of date"],
			["changed-since", "Changed since"],
		];
		for (const [value, label] of choices) {
			const option = temporal.createEl("option", { text: label, value });
			option.selected = value === this.temporal;
		}
		temporal.addEventListener("change", () => {
			this.temporal = temporal.value as Temporal;
			this.renderOptions();
			this.updatePlaceholder();
		});

		if (this.temporal === "as-of" || this.temporal === "changed-since") {
			this.dateInput = this.optionsEl.createEl("input", { type: "date", cls: "memanto-date" });
			this.dateInput.id = "memanto-temporal-date";
			this.dateInput.value = isoDate(this.temporal === "changed-since" ? daysAgo(7) : new Date());
		}

		const types = this.optionsEl.createEl("button", { cls: "memanto-types-button" });
		types.id = "memanto-types-button";
		setIcon(types.createSpan(), "filter");
		types.createSpan({
			text: this.selectedTypes.size ? `${this.selectedTypes.size} types` : "All types",
		});
		if (this.selectedTypes.size) types.addClass("is-active");

		const tray = this.optionsEl.createDiv({ cls: "memanto-type-tray is-hidden" });
		types.addEventListener("click", () => tray.toggleClass("is-hidden", !tray.hasClass("is-hidden")));

		for (const type of MEMORY_TYPES) {
			const chip = tray.createEl("button", { cls: "memanto-chip", text: type });
			chip.toggleClass("is-active", this.selectedTypes.has(type));
			chip.addEventListener("click", () => {
				if (this.selectedTypes.has(type)) this.selectedTypes.delete(type);
				else this.selectedTypes.add(type);
				chip.toggleClass("is-active", this.selectedTypes.has(type));
				types.lastElementChild?.setText(
					this.selectedTypes.size ? `${this.selectedTypes.size} types` : "All types",
				);
				types.toggleClass("is-active", this.selectedTypes.size > 0);
			});
		}
	}

	private updatePlaceholder(): void {
		if (!this.inputEl) return;
		if (this.mode === "answer") {
			this.inputEl.placeholder = "Ask Memanto anything your agents learned…";
		} else if (this.temporal === "search") {
			this.inputEl.placeholder = "Search memories…";
		} else {
			this.inputEl.placeholder = "Optional note — press Enter to load";
		}
	}

	private autoGrow(): void {
		// Collapse first, so scrollHeight measures the text rather than the old box.
		this.inputEl.setCssStyles({ height: "auto" });
		this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 160)}px` });
	}

	// ============================================================ server status

	/** Called by the plugin whenever detection or the server state changes. */
	onServerStatusChanged(): void {
		if (!this.statusPill) return;
		const status = this.plugin.serverStatus;

		const labels: Record<typeof status, string> = {
			checking: "Checking",
			starting: "Starting",
			online: "Online",
			offline: "Offline",
		};
		this.statusPill.empty();
		this.statusPill.className = `memanto-status-pill is-${status}`;
		this.statusPill.createSpan({ cls: "memanto-status-dot" });
		this.statusPill.createSpan({ text: labels[status] });
		this.statusPill.setAttr("aria-label", this.plugin.environment?.baseUrl ?? "");

		const mascotState: MascotState =
			status === "online" ? "idle" : status === "offline" ? "sleeping" : "walking";
		setMascotState(this.headerMascot, mascotState);

		const online = status === "online";
		this.inputEl.disabled = !online;
		this.sendButton.disabled = !online;
		this.agentSelect.disabled = !online;

		if (online) {
			const baseUrl = this.plugin.environment?.baseUrl ?? null;
			if (this.loadedAgentsFor !== baseUrl) void this.loadAgents();
			if (this.messageCount === 0) this.showWelcome();
			else this.removePanel();
			return;
		}

		this.loadedAgentsFor = null;
		if (this.messageCount === 0) this.showStatusPanel(status);
	}

	private async loadAgents(): Promise<void> {
		const environment = this.plugin.environment;
		try {
			const list = await this.plugin.client.listAgents();
			this.agents = list.agents ?? [];
			this.loadedAgentsFor = environment?.baseUrl ?? null;
		} catch (error) {
			if (error instanceof MemantoOfflineError) {
				void this.plugin.refreshEnvironment();
				return;
			}
			this.agentSelect.empty();
			this.agentSelect.createEl("option", { text: "Could not load agents", value: "" });
			new Notice(`Memanto: ${describe(error)}`);
			return;
		}

		this.agentSelect.empty();
		if (this.agents.length === 0) {
			this.agentSelect.createEl("option", { text: "No agents yet", value: "" });
			return;
		}

		const preferred =
			this.plugin.settings.agentId || environment?.activeAgentId || this.agents[0].agent_id;
		const exists = this.agents.some((agent) => agent.agent_id === preferred);

		for (const agent of this.agents) {
			const count = agent.memory_count;
			const label =
				typeof count === "number"
					? `${agent.agent_id} · ${count.toLocaleString()} memories`
					: agent.agent_id;
			const option = this.agentSelect.createEl("option", { text: label, value: agent.agent_id });
			option.selected = agent.agent_id === (exists ? preferred : this.agents[0].agent_id);
		}

		if (this.plugin.settings.agentId !== this.agentSelect.value) {
			this.plugin.settings.agentId = this.agentSelect.value;
			await this.plugin.saveSettings();
		}
	}

	// ================================================================= panels

	private removePanel(): void {
		this.panelEl?.remove();
		this.panelEl = null;
	}

	private newPanel(): HTMLElement {
		this.removePanel();
		this.panelEl = this.threadEl.createDiv({ cls: "memanto-panel" });
		return this.panelEl;
	}

	private showWelcome(): void {
		const panel = this.newPanel();
		createMascot(panel, "idle", "is-hero");
		panel.createEl("h3", {
			cls: "memanto-panel-title",
			text: this.mode === "answer" ? "Ask your agents' memory" : "Search your agents' memory",
		});
		panel.createEl("p", {
			cls: "memanto-panel-text",
			text:
				this.mode === "answer"
					? "Answers are grounded in what your agents actually stored — decisions, preferences, facts and lessons."
					: "Everything your agents remembered, ranked by relevance, with confidence and provenance on every result.",
		});

		const suggestions: Suggestion[] =
			this.mode === "answer"
				? [
						{ label: "What have we decided recently?", run: () => this.ask("What have we decided recently?") },
						{ label: "What are my preferences?", run: () => this.ask("What are my preferences?") },
						{ label: "What mistakes should I avoid?", run: () => this.ask("What mistakes or errors should I avoid repeating?") },
					]
				: [
						{ label: "Show recent memories", run: () => this.runTemporal("recent") },
						{ label: "What changed this week?", run: () => this.runTemporal("changed-since") },
						{ label: "Find decisions", run: () => this.ask("decisions", ["decision"]) },
					];

		const list = panel.createDiv({ cls: "memanto-suggestions" });
		for (const suggestion of suggestions) {
			const button = list.createEl("button", { cls: "memanto-suggestion", text: suggestion.label });
			button.addEventListener("click", suggestion.run);
		}
	}

	private showStatusPanel(status: "checking" | "starting" | "offline"): void {
		const panel = this.newPanel();
		const environment = this.plugin.environment;

		if (status !== "offline") {
			createMascot(panel, "walking", "is-hero");
			panel.createEl("h3", {
				cls: "memanto-panel-title",
				text: status === "starting" ? "Waking Memanto up" : "Looking for Memanto",
			});
			panel.createEl("p", {
				cls: "memanto-panel-text",
				text:
					status === "starting"
						? "Starting a private server for Obsidian. The first start can take a few seconds."
						: "Checking for the Memanto CLI…",
			});
			return;
		}

		createMascot(panel, "sleeping", "is-hero");
		const installed = Boolean(environment?.binaryPath);
		panel.createEl("h3", {
			cls: "memanto-panel-title",
			text: installed ? "Memanto is asleep" : "Memanto isn't installed yet",
		});
		panel.createEl("p", {
			cls: "memanto-panel-text",
			text: installed
				? this.plugin.settings.serverMode === "attach"
					? `Nothing is answering at ${environment?.baseUrl || "your server's address"}. Start it, or switch to a private server in settings. Your synced notes still work.`
					: "The private server isn't running. Your synced notes still work."
				: "Install the Memanto CLI to chat with your agents' memory. It takes about a minute.",
		});

		const lastError = this.plugin.lastServerError;
		if (installed && lastError) {
			panel.createEl("p", { cls: "memanto-panel-error", text: lastError });
		}

		const buttons = panel.createDiv({ cls: "memanto-panel-buttons" });
		if (installed && this.plugin.settings.serverMode === "attach") {
			const retry = buttons.createEl("button", { cls: "mod-cta", text: "Check again" });
			retry.addEventListener("click", () => void this.plugin.refreshEnvironment());
			const usePrivate = buttons.createEl("button", { text: "Use a private server" });
			usePrivate.addEventListener("click", () => void this.plugin.usePrivateServer());
		} else if (installed) {
			const start = buttons.createEl("button", { cls: "mod-cta", text: "Start server" });
			start.addEventListener("click", () => void this.plugin.startServer());
		}
		const setup = buttons.createEl("button", {
			cls: installed ? "" : "mod-cta",
			text: "Setup steps",
		});
		setup.addEventListener("click", () => this.plugin.openSetup());
	}

	// ================================================================ messages

	private clearThread(): void {
		this.threadEl.empty();
		this.panelEl = null;
		this.messageCount = 0;
		this.onServerStatusChanged();
	}

	private scrollToBottom(): void {
		this.threadEl.scrollTo({ top: this.threadEl.scrollHeight, behavior: "smooth" });
	}

	private addUserMessage(text: string): void {
		this.removePanel();
		this.messageCount++;
		const row = this.threadEl.createDiv({ cls: "memanto-msg is-user" });
		row.createDiv({ cls: "memanto-bubble", text });
		this.scrollToBottom();
	}

	private addAssistantShell(mode: Mode, state: MascotState): {
		row: HTMLElement;
		body: HTMLElement;
		avatar: HTMLElement;
	} {
		this.removePanel();
		this.messageCount++;
		const row = this.threadEl.createDiv({ cls: "memanto-msg is-assistant" });
		const avatar = createMascot(row, state, "is-avatar");
		const body = row.createDiv({ cls: "memanto-msg-body" });
		const label = body.createDiv({ cls: `memanto-msg-label is-${mode}` });
		setIcon(label.createSpan(), mode === "answer" ? "sparkles" : "search");
		label.createSpan({ text: mode === "answer" ? "Answer" : "Recall" });
		return { row, body, avatar };
	}

	private addDivider(text: string): void {
		this.threadEl.createDiv({ cls: "memanto-divider", text });
		this.scrollToBottom();
	}

	// ================================================================== submit

	private ask(text: string, types?: string[]): void {
		if (types) {
			this.selectedTypes = new Set(types);
			this.temporal = "search";
			this.renderOptions();
		}
		this.inputEl.value = text;
		void this.submit();
	}

	private runTemporal(temporal: Temporal): void {
		this.temporal = temporal;
		this.renderOptions();
		this.updatePlaceholder();
		this.inputEl.value = "";
		void this.submit();
	}

	private async submit(): Promise<void> {
		if (this.busy || this.plugin.serverStatus !== "online") return;

		const agentId = this.agentSelect.value;
		if (!agentId) {
			new Notice("Memanto: choose an agent first.");
			return;
		}

		const text = this.inputEl.value.trim();
		const needsText = this.mode === "answer" || this.temporal === "search";
		if (needsText && !text) {
			this.inputEl.focus();
			return;
		}

		const mode = this.mode;
		this.addUserMessage(text || this.describeTemporal());
		this.inputEl.value = "";
		this.autoGrow();

		const { row, body, avatar } = this.addAssistantShell(mode, "walking");
		const thinking = body.createDiv({ cls: "memanto-thinking" });
		thinking.createSpan({ text: mode === "answer" ? "Thinking" : "Recalling" });
		const dots = thinking.createSpan({ cls: "memanto-dots" });
		for (let i = 0; i < 3; i++) dots.createSpan();
		this.scrollToBottom();

		this.busy = true;
		this.sendButton.disabled = true;
		try {
			if (mode === "answer") await this.renderAnswer(body, agentId, text);
			else await this.renderRecall(body, agentId, text);
			row.addClass("is-done");
		} catch (error) {
			if (error instanceof MemantoOfflineError) void this.plugin.refreshEnvironment();
			body.createDiv({ cls: "memanto-error", text: describe(error) });
			row.addClass("is-error");
		} finally {
			thinking.remove();
			setMascotState(avatar, "idle");
			this.busy = false;
			this.sendButton.disabled = this.plugin.serverStatus !== "online";
			this.scrollToBottom();
		}
	}

	private describeTemporal(): string {
		switch (this.temporal) {
			case "recent":
				return "Show the most recent memories";
			case "as-of":
				return `What was true as of ${this.dateValue()}?`;
			case "changed-since":
				return `What changed since ${this.dateValue()}?`;
			default:
				return "";
		}
	}

	private dateValue(): string {
		return this.dateInput?.value || isoDate(new Date());
	}

	private async renderAnswer(body: HTMLElement, agentId: string, question: string): Promise<void> {
		const response = await this.plugin.client.answer(agentId, question);
		const answer = response.answer?.trim() || "Memanto had nothing to say about that.";

		const content = body.createDiv({ cls: "memanto-answer markdown-rendered" });
		await MarkdownRenderer.render(this.app, answer, content, "", this);
		this.addActions(body, answer);

		const sources = response.sources ?? [];
		if (sources.length === 0) return;
		const details = body.createEl("details", { cls: "memanto-sources" });
		details.createEl("summary", {
			text: `${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
		});
		for (const source of sources) this.renderMemoryCard(details, source);
	}

	private async renderRecall(body: HTMLElement, agentId: string, query: string): Promise<void> {
		const client = this.plugin.client;
		const options = {
			limit: this.plugin.settings.recallLimit,
			types: Array.from(this.selectedTypes),
		};

		let memories: MemoryItem[];
		switch (this.temporal) {
			case "recent":
				memories = (await client.recallRecent(agentId, options)).memories;
				break;
			case "as-of":
				memories = (await client.recallAsOf(agentId, this.dateValue(), options)).memories;
				break;
			case "changed-since":
				memories = (await client.recallChangedSince(agentId, this.dateValue(), options)).memories;
				break;
			default:
				memories = (await client.recall(agentId, query, options)).memories;
		}

		if (memories.length === 0) {
			body.createDiv({
				cls: "memanto-summary",
				text: "Nothing matched. Try different words, or fewer type filters.",
			});
			return;
		}

		body.createDiv({
			cls: "memanto-summary",
			text: `Found ${memories.length} ${memories.length === 1 ? "memory" : "memories"}`,
		});
		const list = body.createDiv({ cls: "memanto-cards" });
		for (const memory of memories) this.renderMemoryCard(list, memory);
	}

	private renderMemoryCard(parent: HTMLElement, memory: MemoryItem): void {
		const card = parent.createDiv({ cls: "memanto-card" });
		const text = memoryText(memory);

		const meta = card.createDiv({ cls: "memanto-card-meta" });
		if (memory.type) {
			meta.createSpan({ cls: `memanto-type type-${memory.type}`, text: memory.type });
		}
		if (memory.status && memory.status !== "active") {
			meta.createSpan({ cls: "memanto-type is-expired", text: memory.status });
		}
		if (typeof memory.confidence === "number") {
			const confidence = Math.max(0, Math.min(1, memory.confidence));
			const bar = meta.createDiv({ cls: "memanto-confidence" });
			bar.setAttr("aria-label", `Confidence ${Math.round(confidence * 100)}%`);
			const fill = bar.createDiv({ cls: "memanto-confidence-fill" });
			fill.setCssStyles({ width: `${confidence * 100}%` });
			fill.toggleClass("is-low", confidence < 0.5);
			meta.createSpan({ cls: "memanto-confidence-value", text: `${Math.round(confidence * 100)}%` });
		}

		// Memanto derives a title from the first line when none is given, so the
		// title is often just the start of the text. Showing both reads as a stutter.
		const title = memory.title?.replace(/(\.\.\.|…)\s*$/, "").trim();
		if (title && !text.startsWith(title)) {
			card.createDiv({ cls: "memanto-card-title", text: memory.title });
		}
		const content = card.createDiv({ cls: "memanto-card-text", text });
		content.addEventListener("click", () => content.toggleClass("is-expanded", !content.hasClass("is-expanded")));

		const facts: string[] = [];
		if (memory.provenance) facts.push(memory.provenance.replace(/_/g, " "));
		if (memory.source) facts.push(memory.source);
		if (memory.created_at) facts.push(formatDate(memory.created_at));
		if (facts.length) card.createDiv({ cls: "memanto-card-facts", text: facts.join(" · ") });

		this.addActions(card, text, memory);
	}

	private addActions(parent: HTMLElement, text: string, memory?: MemoryItem): void {
		const actions = parent.createDiv({ cls: "memanto-actions" });

		this.iconButton(actions, "text-cursor-input", "Insert into note", () =>
			this.insertIntoNote(text, memory),
		);

		const copy = this.iconButton(actions, "copy", "Copy", () => {
			void (async () => {
				await navigator.clipboard.writeText(text);
				setIcon(copy, "check");
				window.setTimeout(() => setIcon(copy, "copy"), 1200);
			})();
		});

		if (memory?.id) {
			this.iconButton(actions, "file-text", "Open synced note", () =>
				void this.openSyncedNote(memory.id as string),
			);
		}
	}

	/**
	 * Insert into the note the reader was last editing.
	 *
	 * Clicking in this pane makes the pane the active view, so looking up the
	 * active MarkdownView would always come back empty. Use the most recent leaf
	 * in the main editing area instead.
	 */
	private insertIntoNote(text: string, memory?: MemoryItem): void {
		const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		const view = leaf?.view;
		if (!(view instanceof MarkdownView)) {
			new Notice("Open a note first, then insert.");
			return;
		}

		let payload = text;
		if (memory && this.plugin.settings.citeOnInsert) {
			const facts = [memory.type, memory.provenance, memory.created_at?.slice(0, 10)]
				.filter(Boolean)
				.join(", ");
			payload = `${text}\n\n> — Memanto${facts ? ` (${facts})` : ""}`;
		}

		view.editor.replaceSelection(payload);
		new Notice(`Inserted into ${view.file?.basename ?? "note"}.`);
	}

	/**
	 * Jump to the synced note for a memory. The OKF bundle carries the memory id
	 * in `x_memanto.id`, so the metadata cache finds it with no second index.
	 */
	private async openSyncedNote(memoryId: string): Promise<void> {
		const folder = this.plugin.settings.syncFolder;
		const match = this.app.vault.getMarkdownFiles().find((file) => {
			if (!file.path.startsWith(`${folder}/`)) return false;
			const block = this.app.metadataCache.getFileCache(file)?.frontmatter?.x_memanto as
				| { id?: string }
				| undefined;
			return block?.id === memoryId;
		});

		if (!match) {
			new Notice("No synced note for this memory yet. Use “Sync memories to vault” first.");
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(match);
	}
}

function describe(error: unknown): string {
	if (error instanceof MemantoOfflineError) return "The Memanto server stopped responding.";
	if (error instanceof MemantoApiError) return error.message;
	if (error instanceof Error) return error.message;
	return "Something went wrong.";
}

function isoDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(days: number): Date {
	const date = new Date();
	date.setDate(date.getDate() - days);
	return date;
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value.slice(0, 10);
	return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
