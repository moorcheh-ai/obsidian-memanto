/**
 * The Memanto mascot, drawn from the same pixel paths as the official logo
 * (`assets/memanto-logo.svg` in moorcheh-ai/memanto).
 *
 * Built with DOM APIs rather than an HTML string so nothing is ever parsed from
 * markup. Animation lives in styles.css and is driven by a state class:
 *
 * - `idle`     — stands still and winks every few seconds.
 * - `walking`  — legs cycle; shown while recalling, answering or starting up.
 * - `sleeping` — eyes shut and dimmed; shown when no server is reachable.
 */

export type MascotState = "idle" | "walking" | "sleeping";

const SVG_NS = "http://www.w3.org/2000/svg";

const BODY =
	"M 18,0 H 78 V 24 H 66 V 12 H 60 V 24 H 36 V 12 H 30 V 24 H 18 Z M 12,24 H 18 V 48 H 12 Z M 78,24 H 84 V 48 H 78 Z M 18,48 H 78 V 60 H 66 V 72 H 30 V 60 H 18 Z";
const LEGS_STANDING =
	"M 12,72 H 18 V 108 H 12 Z M 24,72 H 30 V 96 H 24 Z M 36,72 H 42 V 84 H 36 Z M 54,72 H 60 V 84 H 54 Z M 66,72 H 72 V 96 H 66 Z M 78,72 H 84 V 108 H 78 Z";
const LEGS_STRIDE =
	"M 12,72 H 18 V 84 H 12 Z M 12,96 H 18 V 108 H 12 Z M 24,72 H 30 V 96 H 24 Z M 36,72 H 42 V 96 H 36 Z M 54,72 H 60 V 96 H 54 Z M 66,72 H 72 V 96 H 66 Z M 78,72 H 84 V 84 H 78 Z M 78,96 H 84 V 108 H 78 Z";

/** Icon registered with `addIcon`, which expects a 100×100 viewBox and currentColor. */
export const MASCOT_ICON = `<g transform="translate(5.6 0) scale(0.925)" fill="currentColor"><path d="${BODY}"/><polygon points="42,32 44,36 42,40 40,36"/><polygon points="54,32 56,36 54,40 52,36"/><path d="${LEGS_STANDING}"/></g>`;

function el<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string>,
	parent?: Element,
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
	parent?.appendChild(node);
	return node;
}

function eye(parent: SVGElement, x: number, winks: boolean): void {
	const open = el("g", { class: winks ? "memanto-eye-open is-winking" : "memanto-eye-open" }, parent);
	el(
		"polygon",
		{
			points: `${x},28 ${x + 4},36 ${x},44 ${x - 4},36`,
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.5",
		},
		open,
	);
	el("polygon", { points: `${x},32 ${x + 2},36 ${x},40 ${x - 2},36` }, open);

	const closed = el(
		"g",
		{ class: winks ? "memanto-eye-closed is-winking" : "memanto-eye-closed" },
		parent,
	);
	el("rect", { x: String(x - 6), y: "34", width: "12", height: "4" }, closed);
}

/** Create a mascot element. Size it with CSS; colour follows `color`. */
export function createMascot(parent: HTMLElement, state: MascotState, cls = ""): HTMLElement {
	const wrap = parent.createDiv({ cls: `memanto-mascot ${cls}`.trim() });
	wrap.setAttr("aria-hidden", "true");

	const svg = el("svg", { viewBox: "0 0 96 108", fill: "currentColor" });
	wrap.appendChild(svg);

	el("path", { d: BODY }, svg);
	const eyes = el("g", { class: "memanto-eyes" }, svg);
	eye(eyes, 42, true);
	eye(eyes, 54, false);
	el("path", { d: LEGS_STANDING, class: "memanto-legs-a" }, svg);
	el("path", { d: LEGS_STRIDE, class: "memanto-legs-b" }, svg);

	setMascotState(wrap, state);
	return wrap;
}

export function setMascotState(mascot: HTMLElement, state: MascotState): void {
	mascot.removeClass("is-idle", "is-walking", "is-sleeping");
	mascot.addClass(`is-${state}`);
}
