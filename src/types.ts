/**
 * Shapes mirrored from the Memanto OpenAPI contract
 * (`sdks/typescript/openapi.json` in moorcheh-ai/memanto).
 *
 * Only the fields this plugin reads are declared. Regenerate against the spec
 * when the API moves; every field below is optional unless the spec marks it
 * required, because a server one minor version behind may omit it.
 */

/** The 13 memory categories Memanto recognises, in the order the CLI lists them. */
export const MEMORY_TYPES = [
	"instruction",
	"fact",
	"decision",
	"goal",
	"commitment",
	"preference",
	"relationship",
	"context",
	"event",
	"learning",
	"observation",
	"artifact",
	"error",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryItem {
	id?: string;
	title?: string;
	/** Some server versions populate `content`, others `text`. Read both. */
	content?: string;
	text?: string;
	type?: string;
	confidence?: number;
	status?: string;
	tags?: string[];
	created_at?: string;
	updated_at?: string;
	expired_at?: string;
	expired_by?: string;
	source?: string;
	source_ref?: string;
	agent_id?: string;
	score?: number;
	provenance?: string;
	change_type?: string;
}

export interface AgentInfo {
	agent_id: string;
	namespace: string;
	pattern: string;
	description?: string | null;
	created_at: string;
	last_session?: string | null;
	memory_count?: number | null;
	session_count?: number | null;
	status?: string | null;
}

export interface AgentList {
	agents: AgentInfo[];
	count: number;
	warnings?: string[] | null;
}

export interface Session {
	session_id: string;
	session_token: string;
	agent_id: string;
	namespace: string;
	started_at: string;
	expires_at: string;
}

export interface RecallResponse {
	agent_id: string;
	session_id: string;
	query: string;
	memories: MemoryItem[];
	count: number;
}

export interface TemporalRecallResponse {
	agent_id: string;
	session_id: string;
	memories: MemoryItem[];
	count: number;
	temporal_mode: string;
	as_of_date?: string | null;
	since_date?: string | null;
}

export interface AnswerResponse {
	agent_id: string;
	session_id: string;
	question: string;
	answer: string;
	sources?: MemoryItem[] | null;
	namespace: string;
}

/** Text of a memory, whichever field the server used to carry it. */
export function memoryText(memory: MemoryItem): string {
	return (memory.content ?? memory.text ?? "").trim();
}
