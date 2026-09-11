import {
	ItemView,
	MarkdownView,
	Notice,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";
import { MemantoApiError, MemantoOfflineError } from "../api/client";
import { MEMORY_TYPES, memoryText, type AgentInfo, type MemoryItem } from "../types";
import type MemantoPlugin from "../main";

export const MEMANTO_VIEW_TYPE = "memanto-view";

type Mode = "recall" | "answer";
type Temporal = "search" | "recent" | "as-of" | "changed-since";

/**
 * The side pane: one place to search the estate and to ask it questions.
 *
 * Recall and answer are separate modes rather than one box, because they return
 * genuinely different things — a ranked list of what is stored, versus a single
 * grounded reply. Blurring them hides which one produced the text on screen.
 */
export class MemantoView extends ItemView {
	private mode: Mode = "recall";
	private temporal: Temporal = "search";
	private selectedTypes = new Set<string>();
	private agents: AgentInfo[] = [];
	private busy = false;

	private queryInput!: HTMLInputElement;
	private temporalInput!: HTMLInputElement;
	private agentSelect!: HTMLSelectElement;
	private resultsEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private filtersEl!: HTMLElement;

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
		return "brain-circuit";
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.loadAgents();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	// ---------------------------------------------------------------- layout

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("memanto-pane");

		this.renderControls(root.createDiv({ cls: "memanto-controls" }));
		this.statusEl = root.createDiv({ cls: "memanto-pane-status" });
		this.resultsEl = root.createDiv({ cls: "memanto-results" });

		this.showIdleState();
	}

	private renderControls(container: HTMLElement): void {
		const agentRow = container.createDiv({ cls: "memanto-row" });
		this.agentSelect = agentRow.createEl("select", { cls: "dropdown memanto-agent" });
		this.agentSelect.addEventListener("change", () => {
			this.plugin.settings.agentId = this.agentSelect.value;
			void this.plugin.saveSettings();
			this.clearResults();
		});

		const refresh = agentRow.createEl("button", { cls: "memanto-icon-button" });
		refresh.setAttr("aria-label", "Reload agents");
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.loadAgents());

		const modeRow = container.createDiv({ cls: "memanto-row memanto-modes" });
		for (const mode of ["recall", "answer"] as Mode[]) {
			const button = modeRow.createEl("button", {
				text: mode === "recall" ? "Recall" : "Answer",
				cls: this.mode === mode ? "memanto-mode is-active" : "memanto-mode",
			});
			button.addEventListener("click", () => {
				this.mode = mode;
				this.render();
			});
		}

		const queryRow = container.createDiv({ cls: "memanto-row" });
		this.queryInput = queryRow.createEl("input", {
			type: "text",
			cls: "memanto-query",
			placeholder:
				this.mode === "answer" ? "Ask a question…" : "Search the estate…",
		});
		this.queryInput.id = "memanto-query-input";
		this.queryInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") void this.submit();
		});

		const go = queryRow.createEl("button", { text: "Go", cls: "mod-cta" });
		go.addEventListener("click", () => void this.submit());

		if (this.mode === "recall") this.renderRecallFilters(container);
	}

	private renderRecallFilters(container: HTMLElement): void {
		const temporalRow = container.createDiv({ cls: "memanto-row" });
		const select = temporalRow.createEl("select", { cls: "dropdown" });
		const options: Array<[Temporal, string]> = [
			["search", "Search"],
			["recent", "Most recent"],
			["as-of", "As of a date"],
			["changed-since", "Changed since"],
		];
		for (const [value, label] of options) {
			const option = select.createEl("option", { text: label, value });
			if (value === this.temporal) option.selected = true;
		}
		select.addEventListener("change", () => {
			this.temporal = select.value as Temporal;
			this.render();
		});

		if (this.temporal === "as-of" || this.temporal === "changed-since") {
			this.temporalInput = temporalRow.createEl("input", {
				type: "date",
				cls: "memanto-date",
			});
			this.temporalInput.id = "memanto-temporal-date";
			this.temporalInput.value = new Date().toISOString().slice(0, 10);
		}

		const details = container.createEl("details", { cls: "memanto-filters" });
		details.createEl("summary", {
			text: this.selectedTypes.size
				? `Types (${this.selectedTypes.size} selected)`
				: "Types (all)",
		});
		this.filtersEl = details.createDiv({ cls: "memanto-chips" });

		for (const type of MEMORY_TYPES) {
			const chip = this.filtersEl.createEl("button", { text: type, cls: "memanto-chip" });
			if (this.selectedTypes.has(type)) chip.addClass("is-active");
			chip.addEventListener("click", () => {
				if (this.selectedTypes.has(type)) this.selectedTypes.delete(type);
				else this.selectedTypes.add(type);
				this.render();
				details.open = true;
			});
		}
	}

	// ------------------------------------------------------------------ data

	/** Populate the agent picker. Falls back to whatever the CLI last activated. */
	async loadAgents(): Promise<void> {
		const environment = this.plugin.environment;
		if (!environment?.serverUp) {
			this.showOfflineState();
			return;
		}

		try {
			const list = await this.plugin.client.listAgents();
			this.agents = list.agents ?? [];
		} catch (error) {
			this.showError(error);
			return;
		}

		this.agentSelect.empty();
		if (this.agents.length === 0) {
			this.agentSelect.createEl("option", { text: "No agents yet", value: "" });
			this.setStatus("This account has no agents. Create one with `memanto agent create`.");
			return;
		}

		const preferred =
			this.plugin.settings.agentId || environment.activeAgentId || this.agents[0].agent_id;

		for (const agent of this.agents) {
			const count = agent.memory_count;
			const label =
				typeof count === "number"
					? `${agent.agent_id} (${count.toLocaleString()})`
					: agent.agent_id;
			const option = this.agentSelect.createEl("option", { text: label, value: agent.agent_id });
			if (agent.agent_id === preferred) option.selected = true;
		}

		this.plugin.settings.agentId = this.agentSelect.value;
		await this.plugin.saveSettings();
		this.showIdleState();
	}

	private async submit(): Promise<void> {
		if (this.busy) return;

		const agentId = this.agentSelect.value;
		if (!agentId) {
			this.setStatus("Choose an agent first.");
			return;
		}

		const query = this.queryInput.value.trim();
		const needsQuery = this.mode === "answer" || this.temporal === "search";
		if (needsQuery && !query) {
			this.setStatus(this.mode === "answer" ? "Ask a question first." : "Enter a search first.");
			return;
		}

		this.busy = true;
		this.setStatus(this.mode === "answer" ? "Thinking…" : "Searching…");
		this.resultsEl.empty();

		try {
			if (this.mode === "answer") await this.runAnswer(agentId, query);
			else await this.runRecall(agentId, query);
		} catch (error) {
			this.showError(error);
		} finally {
			this.busy = false;
		}
	}

	private async runAnswer(agentId: string, question: string): Promise<void> {
		const response = await this.plugin.client.answer(agentId, question);
		this.setStatus("");
		this.renderAnswer(question, response.answer, response.sources ?? []);
	}

	private async runRecall(agentId: string, query: string): Promise<void> {
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
				memories = (await client.recallAsOf(agentId, this.temporalDate(), options)).memories;
				break;
			case "changed-since":
				memories = (await client.recallChangedSince(agentId, this.temporalDate(), options))
					.memories;
				break;
			default:
				memories = (await client.recall(agentId, query, options)).memories;
		}

		this.setStatus(
			memories.length === 0
				? "Nothing matched."
				: `${memories.length} ${memories.length === 1 ? "memory" : "memories"}.`,
		);
		for (const memory of memories) this.renderMemory(memory);
	}

	private temporalDate(): string {
		return this.temporalInput?.value || new Date().toISOString().slice(0, 10);
	}

	// -------------------------------------------------------------- rendering

	private renderAnswer(question: string, answer: string, sources: MemoryItem[]): void {
		const card = this.resultsEl.createDiv({ cls: "memanto-card memanto-answer" });
		card.createEl("p", { cls: "memanto-question", text: question });
		card.createEl("div", { cls: "memanto-answer-body", text: answer });

		this.renderActions(card, answer);

		if (sources.length === 0) return;
		const details = card.createEl("details", { cls: "memanto-sources" });
		details.createEl("summary", {
			text: `${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
		});
		for (const source of sources) this.renderMemory(source, details);
	}

	private renderMemory(memory: MemoryItem, parent: HTMLElement = this.resultsEl): void {
		const card = parent.createDiv({ cls: "memanto-card" });
		const text = memoryText(memory);

		const meta = card.createDiv({ cls: "memanto-meta" });
		if (memory.type) meta.createSpan({ cls: `memanto-pill type-${memory.type}`, text: memory.type });
		if (memory.status && memory.status !== "active") {
			meta.createSpan({ cls: "memanto-pill is-expired", text: memory.status });
		}
		if (typeof memory.confidence === "number") {
			this.renderConfidence(meta, memory.confidence);
		}

		if (memory.title) card.createEl("h4", { cls: "memanto-title", text: memory.title });
		card.createEl("p", { cls: "memanto-body", text: text });

		const footer = card.createDiv({ cls: "memanto-footer" });
		const facts: string[] = [];
		if (memory.provenance) facts.push(memory.provenance.replace(/_/g, " "));
		if (memory.source) facts.push(memory.source);
		if (memory.created_at) facts.push(formatDate(memory.created_at));
		if (typeof memory.score === "number") facts.push(`score ${memory.score.toFixed(2)}`);
		footer.createSpan({ cls: "memanto-facts", text: facts.join(" · ") });

		this.renderActions(card, text, memory);
	}

	/** Confidence as a bar, because a bare 0.87 reads as noise in a list. */
	private renderConfidence(container: HTMLElement, confidence: number): void {
		const wrap = container.createDiv({ cls: "memanto-confidence" });
		wrap.setAttr("aria-label", `Confidence ${Math.round(confidence * 100)}%`);
		const fill = wrap.createDiv({ cls: "memanto-confidence-fill" });
		fill.style.width = `${Math.max(0, Math.min(1, confidence)) * 100}%`;
		if (confidence < 0.5) fill.addClass("is-low");
		container.createSpan({
			cls: "memanto-confidence-value",
			text: confidence.toFixed(2),
		});
	}

	private renderActions(card: HTMLElement, text: string, memory?: MemoryItem): void {
		const actions = card.createDiv({ cls: "memanto-actions" });

		const insert = actions.createEl("button", { text: "Insert at cursor" });
		insert.addEventListener("click", () => this.insertAtCursor(text, memory));

		const copy = actions.createEl("button", { text: "Copy" });
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(text);
			copy.setText("Copied");
			setTimeout(() => copy.setText("Copy"), 1200);
		});

		if (!memory?.id) return;
		const open = actions.createEl("button", { text: "Open note" });
		open.addEventListener("click", () => void this.openSyncedNote(memory.id as string));
	}

	private insertAtCursor(text: string, memory?: MemoryItem): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
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
	}

	/**
	 * Jump to the synced note for a memory.
	 *
	 * The OKF bundle carries the memory id in `x_memanto.id`, so the metadata
	 * cache can find the note without us maintaining a second index.
	 */
	private async openSyncedNote(memoryId: string): Promise<void> {
		const folder = this.plugin.settings.syncFolder;
		const match = this.app.vault.getMarkdownFiles().find((file) => {
			if (!file.path.startsWith(`${folder}/`)) return false;
			const cache = this.app.metadataCache.getFileCache(file);
			const block = cache?.frontmatter?.x_memanto as { id?: string } | undefined;
			return block?.id === memoryId;
		});

		if (!match) {
			new Notice("No synced note for this memory yet. Run “Sync memories to vault”.");
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(match);
	}

	// ----------------------------------------------------------------- states

	private clearResults(): void {
		this.resultsEl.empty();
		this.showIdleState();
	}

	private showIdleState(): void {
		const environment = this.plugin.environment;
		if (!environment?.serverUp) {
			this.showOfflineState();
			return;
		}
		this.setStatus(
			this.mode === "answer"
				? "Ask a question and Memanto answers from what your agents stored."
				: "Search the estate, or pick a temporal view.",
		);
	}

	/**
	 * The most common failure by far, so it gets a real explanation and a way
	 * out rather than an error string.
	 */
	private showOfflineState(): void {
		this.resultsEl.empty();
		this.setStatus("");

		const empty = this.resultsEl.createDiv({ cls: "memanto-empty" });
		empty.createEl("h4", { text: "No Memanto server" });
		empty.createEl("p", {
			text: `Nothing is answering at ${this.plugin.environment?.baseUrl ?? "the configured address"}. Synced notes still work — this pane needs the server.`,
		});

		const retry = empty.createEl("button", { text: "Check again", cls: "mod-cta" });
		retry.addEventListener("click", async () => {
			await this.plugin.refreshEnvironment();
			await this.loadAgents();
		});

		empty
			.createEl("button", { text: "Setup steps" })
			.addEventListener("click", () => this.plugin.openSetup());
	}

	private showError(error: unknown): void {
		this.resultsEl.empty();

		if (error instanceof MemantoOfflineError) {
			void this.plugin.refreshEnvironment();
			this.showOfflineState();
			return;
		}

		const message =
			error instanceof MemantoApiError
				? error.message
				: error instanceof Error
					? error.message
					: "Something went wrong.";

		this.setStatus("");
		const empty = this.resultsEl.createDiv({ cls: "memanto-empty" });
		empty.createEl("h4", { text: "Memanto could not answer" });
		empty.createEl("p", { text: message });
	}

	private setStatus(text: string): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-hidden", text === "");
	}
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value.slice(0, 10);
	return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
