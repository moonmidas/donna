/**
 * Donna Extension — Persistent holographic memory for pi
 *
 * Provides cross-session memory via the donna TypeScript library
 * (FHRR-backed facts + graph-backed notes).
 *
 * Features:
 * - LLM-callable `donna` tool (remember/recall/forget/list)
 * - System prompt injection of preferences & learnings
 * - Auto-capture of file paths from tool results
 * - Preference extraction from user input
 * - Context-aware compaction summaries
 * - State reconstruction from session history
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { NuggetShelf, promoteFacts } from "../../src/nuggets/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Fact {
	key: string;
	value: string;
}

interface DonnaDetails {
	action: "remember" | "recall" | "forget" | "list";
	facts: Record<string, string>;
	error?: string;
}

interface NoteToolDetails {
	action: "create" | "edit" | "link" | "search";
	error?: string;
}

type MemoryScopeParam = "user" | "self" | "shared" | "all";

// ---------------------------------------------------------------------------
// Shelf instance — direct library access (no CLI bridge)
// ---------------------------------------------------------------------------

const MEMORY_NUGGET = "memory";
const USER_SUBJECT = "user:primary";
const SELF_SUBJECT = "assistant:self";
const SHARED_SUBJECT = "shared:project";

const shelf = new NuggetShelf();
shelf.loadAll();

function normalizeScope(scope?: string): MemoryScopeParam {
	if (scope === "self" || scope === "shared" || scope === "all") return scope;
	return "user";
}

function scopePrefix(scope: MemoryScopeParam): string {
	if (scope === "self") return "self";
	if (scope === "shared") return "shared";
	return "user";
}

function stripScopePrefix(key: string): string {
	return key.replace(/^(user|self|shared|project):/i, "");
}

function inferTypeFromKey(key: string): string {
	const lower = key.toLowerCase();
	if (lower.includes("pref:")) return "preference";
	if (lower.includes("learn")) return "reflection";
	return "fact";
}

function buildScopedKey(scope: MemoryScopeParam, key: string): string {
	if (/^(user|self|shared|project):/i.test(key)) return key;
	return `${scopePrefix(scope)}:${key}`;
}

function noteMetaForScope(scope: MemoryScopeParam, type?: string, source?: string, stability?: string) {
	const normalizedScope = normalizeScope(scope);
	return {
		subject:
			normalizedScope === "self"
				? SELF_SUBJECT
				: normalizedScope === "shared"
					? SHARED_SUBJECT
					: USER_SUBJECT,
		scope: normalizedScope === "shared" ? "shared" : normalizedScope,
		type: (type as any) || (normalizedScope === "self" ? "self_model" : "fact"),
		source: (source as any) || (normalizedScope === "self" ? "agent_reflection" : "explicit_user"),
		confidence: source === "inferred" ? 0.6 : normalizedScope === "self" ? 0.75 : 0.95,
		stability: (stability as any) || "durable",
	};
}

function shelfRemember(
	nuggetName: string,
	key: string,
	value: string,
	scope: MemoryScopeParam = "user",
	type?: string,
	source?: string,
	stability?: string,
): void {
	const nugget = shelf.getOrCreate(nuggetName);
	nugget.remember(buildScopedKey(scope, key), value, {
		...noteMetaForScope(scope, type || inferTypeFromKey(key), source, stability),
	});
}

function shelfRecall(query: string, nuggetName?: string, sessionId = ""): {
	found: boolean;
	answer: string | null;
	confidence: number;
	nugget_name: string | null;
	margin: number;
} {
	return shelf.recall(query, nuggetName, sessionId);
}

function shelfForget(nuggetName: string, key: string): boolean {
	try {
		return shelf.get(nuggetName).forget(key);
	} catch {
		return false;
	}
}

function shelfFacts(nuggetName: string): Fact[] {
	try {
		return shelf.get(nuggetName).facts().map((f) => ({ key: f.key, value: f.value }));
	} catch {
		return [];
	}
}

function formatNoteMatches(query: string, scope: MemoryScopeParam = "all"): string {
	const matches = shelf.searchNotes(
		query,
		MEMORY_NUGGET,
		5,
		scope === "all" ? undefined : { scope: normalizeScope(scope) as any },
	);
	if (matches.length === 0) return `No notes found for: ${query}`;
	return matches
		.map((match) => `- [${match.note.id}] ${match.note.title}: ${match.note.content} [scope=${match.note.scope}, score=${match.score.toFixed(3)}]`)
		.join("\n");
}

function groupFacts(allFacts: Fact[]) {
	return {
		self: allFacts.filter((f) => f.key.startsWith("self:")),
		user: allFacts.filter((f) => f.key.startsWith("user:")),
		shared: allFacts.filter((f) => f.key.startsWith("shared:") || f.key.startsWith("project:") || f.key.startsWith("_")),
	};
}

function topNotes(scope: Exclude<MemoryScopeParam, "all">): Array<{ title: string; content: string; type: string }> {
	try {
		return shelf
			.listNotes(MEMORY_NUGGET, { scope: scope as any })
			.filter((note) => !note.hidden && note.stability === "durable")
			.sort((a, b) => (b.hits - a.hits) || b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 4)
			.map((note) => ({
				title: note.title,
				content: note.content,
				type: note.type,
			}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// In-memory session state (for session-only tracking + system prompt injection)
// ---------------------------------------------------------------------------

let facts: Map<string, string> = new Map();

function factsToRecord(): Record<string, string> {
	return Object.fromEntries(facts);
}

function factsToList(): Fact[] {
	return [...facts.entries()].map(([key, value]) => ({ key, value }));
}

// ---------------------------------------------------------------------------
// Preference extraction
// ---------------------------------------------------------------------------

const PREF_PATTERNS = [
	{ regex: /\balways use (\w[\w\s]*\w|\w+)\b/i, prefix: "pref:always" },
	{ regex: /\bI prefer (\w[\w\s]*\w|\w+)\b/i, prefix: "pref:prefer" },
	{ regex: /\bnever (?:use )?(\w[\w\s]*\w|\w+)\b/i, prefix: "pref:never" },
	{ regex: /\bremember that (.+)/i, prefix: "learn" },
];

function extractPreference(text: string): { key: string; value: string } | null {
	for (const { regex, prefix } of PREF_PATTERNS) {
		const match = text.match(regex);
		if (match && match[1]) {
			const value = match[1].trim().slice(0, 100);
			const shortKey = value.slice(0, 30).replace(/\s+/g, "-").toLowerCase();
			return { key: `${prefix}:${shortKey}`, value };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// System prompt formatting
// ---------------------------------------------------------------------------

function buildInjection(allFacts: Fact[]): string {
	const hasAnyNotes = topNotes("self").length > 0 || topNotes("user").length > 0 || topNotes("shared").length > 0;
	if (allFacts.length === 0 && !hasAnyNotes) return "";

	let injection = "\n\n## Donna — Persistent Memory\n";
	const grouped = groupFacts(allFacts);
	const sections: Array<{
		title: string;
		facts: Fact[];
		notes: Array<{ title: string; content: string; type: string }>;
	}> = [
		{ title: "Assistant Self", facts: grouped.self, notes: topNotes("self") },
		{ title: "User Memory", facts: grouped.user, notes: topNotes("user") },
		{ title: "Shared Context", facts: grouped.shared, notes: topNotes("shared") },
	];

	for (const section of sections) {
		if (section.facts.length === 0 && section.notes.length === 0) continue;
		injection += `\n### ${section.title}\n`;
		for (const fact of section.facts.slice(-8)) {
			injection += `- ${stripScopePrefix(fact.key)}: ${fact.value}\n`;
		}
		for (const note of section.notes) {
			injection += `- note (${note.type}) ${stripScopePrefix(note.title)}: ${note.content}\n`;
		}
	}

	return injection;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const DonnaParams = Type.Object({
	action: StringEnum(["remember", "recall", "forget", "list"] as const),
	key: Type.Optional(Type.String({ description: "Fact key (for remember/forget)" })),
	value: Type.Optional(Type.String({ description: "Fact value (for remember)" })),
	query: Type.Optional(Type.String({ description: "Search query (for recall)" })),
	scope: Type.Optional(Type.String({ description: "Memory scope: user, self, shared, or all" })),
});

const CreateNoteParams = Type.Object({
	title: Type.String({ description: "Short note title" }),
	content: Type.String({ description: "Note body" }),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional note tags" })),
	scope: Type.Optional(Type.String({ description: "Memory scope: user, self, or shared" })),
	note_type: Type.Optional(Type.String({ description: "Optional note type, such as reflection, self_model, preference, or project" })),
	stability: Type.Optional(Type.String({ description: "temporary or durable" })),
});

const AddLinkParams = Type.Object({
	note1: Type.String({ description: "Source note id or exact title" }),
	note2: Type.String({ description: "Target note id or exact title" }),
	reason: Type.String({ description: "Why these notes are connected" }),
});

const EditNoteParams = Type.Object({
	noteId: Type.String({ description: "Note id to edit" }),
	newContent: Type.String({ description: "Replacement content" }),
	title: Type.Optional(Type.String({ description: "Optional new title" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional replacement tags" })),
	note_type: Type.Optional(Type.String({ description: "Optional replacement note type" })),
	stability: Type.Optional(Type.String({ description: "temporary or durable" })),
});

const SearchNotesParams = Type.Object({
	query: Type.String({ description: "What to search for in the note graph" }),
	scope: Type.Optional(Type.String({ description: "Memory scope: user, self, shared, or all" })),
});

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------
	// State reconstruction from session history
	// -------------------------------------------------------------------

	const reconstructState = (ctx: ExtensionContext) => {
		facts = new Map();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "donna") continue;

			const details = msg.details as DonnaDetails | undefined;
			if (details?.facts) {
				for (const [k, v] of Object.entries(details.facts)) {
					if (v) {
						facts.set(k, v);
					} else {
						facts.delete(k);
					}
				}
			}
		}
	};

	// Reconstruct on all session lifecycle events
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);

		// Hydrate from shelf (cross-session facts)
		const shelfFactsList = shelfFacts(MEMORY_NUGGET);
		for (const f of shelfFactsList) {
			if (!facts.has(f.key)) {
				facts.set(f.key, f.value);
			}
		}
	});

	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// -------------------------------------------------------------------
	// Register the donna tool — LLM calls this directly
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "donna",
		label: "Donna Memory",
		description:
			"Persistent memory that survives across sessions. " +
			"Actions: remember (key + value), recall (query), forget (key), list. " +
			"Use to store preferences, learnings, file locations, commands, and patterns.",
		promptSnippet: "donna: store and retrieve persistent facts across sessions",
		promptGuidelines: [
			"Use donna to remember useful discoveries (file paths, patterns, commands)",
			"Before searching for something, recall from donna first",
			"Store user preferences when they say 'always', 'prefer', or 'never'",
			"Keep values short — one sentence max",
		],
		parameters: DonnaParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "remember": {
					if (!params.key || !params.value) {
						return {
							content: [{ type: "text", text: "Error: key and value required for remember" }],
							details: { action: "remember", facts: factsToRecord(), error: "key and value required" } as DonnaDetails,
							isError: true,
						};
					}

					const scope = normalizeScope(params.scope);
					const scopedKey = buildScopedKey(scope, params.key);
					facts.set(scopedKey, params.value);
					shelfRemember(MEMORY_NUGGET, params.key, params.value, scope);

					return {
						content: [{ type: "text", text: `Remembered (${scope}): ${params.key} = ${params.value}` }],
						details: { action: "remember", facts: factsToRecord() } as DonnaDetails,
					};
				}

				case "recall": {
					const query = params.query || params.key || "";
					if (!query) {
						return {
							content: [{ type: "text", text: "Error: query required for recall" }],
							details: { action: "recall", facts: factsToRecord(), error: "query required" } as DonnaDetails,
							isError: true,
						};
					}

					const scope = normalizeScope(params.scope || "all");

					// FHRR-backed recall via shelf
					const result = shelfRecall(scope === "all" ? query : buildScopedKey(scope, query), MEMORY_NUGGET);
					if (result.found && result.answer) {
						return {
							content: [
								{
									type: "text",
									text: `${result.answer}\n[confidence=${result.confidence.toFixed(3)}, source=${result.nugget_name || "memory"}]`,
								},
							],
							details: { action: "recall", facts: factsToRecord() } as DonnaDetails,
						};
					}

					const noteResults = formatNoteMatches(query, scope);
					if (!noteResults.startsWith("No notes found")) {
						return {
							content: [{ type: "text", text: noteResults }],
							details: { action: "recall", facts: factsToRecord() } as DonnaDetails,
						};
					}

					// Fallback: search in-memory facts
					const queryLower = query.toLowerCase();
					const matches = [...facts.entries()].filter(
						([k, v]) =>
							(scope === "all" || k.startsWith(`${scopePrefix(scope)}:`)) &&
							(k.toLowerCase().includes(queryLower) || v.toLowerCase().includes(queryLower)),
					);

					if (matches.length === 0) {
						return {
							content: [{ type: "text", text: `No facts found for: ${query}` }],
							details: { action: "recall", facts: factsToRecord() } as DonnaDetails,
						};
					}

					const text = matches.map(([k, v]) => `- ${stripScopePrefix(k)}: ${v}`).join("\n");
					return {
						content: [{ type: "text", text }],
						details: { action: "recall", facts: factsToRecord() } as DonnaDetails,
					};
				}

				case "forget": {
					if (!params.key) {
						return {
							content: [{ type: "text", text: "Error: key required for forget" }],
							details: { action: "forget", facts: factsToRecord(), error: "key required" } as DonnaDetails,
							isError: true,
						};
					}

					const scope = normalizeScope(params.scope);
					const scopedKey = buildScopedKey(scope, params.key);
					const existed = facts.delete(scopedKey);
					shelfForget(MEMORY_NUGGET, scopedKey);

					return {
						content: [{ type: "text", text: existed ? `Forgot (${scope}): ${params.key}` : `Key not found: ${params.key}` }],
						details: { action: "forget", facts: factsToRecord() } as DonnaDetails,
					};
				}

				case "list": {
					const scope = normalizeScope(params.scope || "all");
					const allFacts = factsToList().filter((fact) =>
						scope === "all" ? true : fact.key.startsWith(`${scopePrefix(scope)}:`),
					);
					if (allFacts.length === 0) {
						return {
							content: [{ type: "text", text: "No facts stored" }],
							details: { action: "list", facts: factsToRecord() } as DonnaDetails,
						};
					}

					const text = allFacts.map((f) => `- ${stripScopePrefix(f.key)}: ${f.value}`).join("\n");
					return {
						content: [{ type: "text", text: `${allFacts.length} facts${scope === "all" ? "" : ` in ${scope}`}:\n${text}` }],
						details: { action: "list", facts: factsToRecord() } as DonnaDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", facts: factsToRecord(), error: `unknown: ${params.action}` } as DonnaDetails,
						isError: true,
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("donna ")) + theme.fg("muted", args.action);
			if (args.key) text += ` ${theme.fg("accent", args.key)}`;
			if (args.value) text += ` ${theme.fg("dim", `"${args.value}"`)}`;
			if (args.query) text += ` ${theme.fg("dim", `"${args.query}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as DonnaDetails | undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const factCount = Object.keys(details.facts).length;

			switch (details.action) {
				case "remember":
					return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", `Stored (${factCount} facts total)`), 0, 0);

				case "recall": {
					const text = result.content[0];
					const content = text?.type === "text" ? text.text : "No results";
					if (!expanded && content.length > 80) {
						return new Text(theme.fg("muted", content.slice(0, 80) + "..."), 0, 0);
					}
					return new Text(theme.fg("muted", content), 0, 0);
				}

				case "forget":
					return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", `Removed (${factCount} facts remaining)`), 0, 0);

				case "list": {
					const summary = theme.fg("muted", `${factCount} facts`);
					if (!expanded) return new Text(summary, 0, 0);
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : summary, 0, 0);
				}
			}
		},
	});

	pi.registerTool({
		name: "createNote",
		label: "Create Memory Note",
		description: "Create a graph note in persistent Donna memory.",
		promptSnippet: "createNote: add a new note to the memory graph",
		promptGuidelines: [
			"Use createNote for durable notes that are richer than a single fact",
			"Keep titles short and content specific",
		],
		parameters: CreateNoteParams,

		async execute(_toolCallId, params) {
			const scope = normalizeScope(params.scope);
			const note = shelf.createNote(
				MEMORY_NUGGET,
				buildScopedKey(scope, params.title),
				params.content,
				params.tags ?? [],
				noteMetaForScope(scope, params.note_type || (scope === "self" ? "self_model" : "note"), scope === "self" ? "agent_reflection" : "explicit_user", params.stability),
			);
			return {
				content: [{ type: "text", text: `Created ${scope} note [${note.id}] ${stripScopePrefix(note.title)}` }],
				details: { action: "create" } as NoteToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "addLink",
		label: "Link Memory Notes",
		description: "Create a bidirectional link between two Donna notes.",
		promptSnippet: "addLink: connect two memory notes with a reason",
		parameters: AddLinkParams,

		async execute(_toolCallId, params) {
			const linked = shelf.addLink(MEMORY_NUGGET, params.note1, params.note2, params.reason);
			if (!linked) {
				return {
					content: [{ type: "text", text: "Could not link notes. Use note ids or exact titles." }],
					details: { action: "link", error: "not found" } as NoteToolDetails,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Linked ${params.note1} ↔ ${params.note2}` }],
				details: { action: "link" } as NoteToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "editNote",
		label: "Edit Memory Note",
		description: "Rewrite a Donna graph note.",
		promptSnippet: "editNote: update a persistent memory note",
		parameters: EditNoteParams,

		async execute(_toolCallId, params) {
			const updated = shelf.editNote(MEMORY_NUGGET, params.noteId, params.newContent, {
				title: params.title,
				tags: params.tags,
				noteMeta: params.note_type || params.stability
					? {
						type: params.note_type as any,
						stability: params.stability as any,
					}
					: undefined,
			});
			if (!updated) {
				return {
					content: [{ type: "text", text: `Note not found: ${params.noteId}` }],
					details: { action: "edit", error: "not found" } as NoteToolDetails,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Updated note [${updated.id}] ${updated.title}` }],
				details: { action: "edit" } as NoteToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "searchNotes",
		label: "Search Memory Notes",
		description: "Search the Zettelkasten memory graph using text and FHRR similarity.",
		promptSnippet: "searchNotes: search the memory graph",
		parameters: SearchNotesParams,

		async execute(_toolCallId, params) {
			const scope = normalizeScope(params.scope || "all");
			return {
				content: [{ type: "text", text: formatNoteMatches(params.query, scope) }],
				details: { action: "search" } as NoteToolDetails,
			};
		},
	});

	// -------------------------------------------------------------------
	// /donna command — show facts in an overlay
	// -------------------------------------------------------------------

	pi.registerCommand("donna", {
		description: "Show all nugget facts",
		handler: async (_args, ctx) => {
			const allFacts = factsToList();

			if (!ctx.hasUI) {
				ctx.ui.notify(`${allFacts.length} facts in memory`, "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new DonnaListComponent(allFacts, theme, () => done());
			});
		},
	});

	// -------------------------------------------------------------------
	// System prompt injection — before each agent turn
	// -------------------------------------------------------------------

	pi.on("before_agent_start", async (event, _ctx) => {
		const allFacts = factsToList();
		const injection = buildInjection(allFacts);
		if (!injection) return;

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// -------------------------------------------------------------------
	// Auto-capture from tool results
	// -------------------------------------------------------------------

	pi.on("tool_result", async (event, _ctx) => {
		const filePath = (event.input as any)?.file_path || (event.input as any)?.path;

		if (filePath && typeof filePath === "string") {
			const basename = filePath.split("/").pop() || filePath;

			if (event.toolName === "read") {
				facts.set(`shared:file:${basename}`, filePath);
				shelfRemember(MEMORY_NUGGET, `file:${basename}`, filePath, "shared", "project", "tool_observation");
			} else if (event.toolName === "edit" || event.toolName === "write") {
				facts.set(`shared:edited:${basename}`, filePath);
				shelfRemember(MEMORY_NUGGET, `edited:${basename}`, filePath, "shared", "project", "tool_observation");
			}
		}

		return;
	});

	// -------------------------------------------------------------------
	// Preference extraction from user input
	// -------------------------------------------------------------------

	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const pref = extractPreference(event.text);
		if (pref) {
			const scopedKey = buildScopedKey("user", pref.key);
			facts.set(scopedKey, pref.value);
			shelfRemember(MEMORY_NUGGET, pref.key, pref.value, "user", "preference", "explicit_user");
		}

		return { action: "continue" as const };
	});

	// -------------------------------------------------------------------
	// Smart compaction — store context before messages are discarded
	// -------------------------------------------------------------------

	pi.on("session_before_compact", async (event, _ctx) => {
		const { messagesToSummarize } = event.preparation;

		const userMessages = messagesToSummarize
			.filter((m: any) => m.role === "user")
			.map((m: any) => {
				if (typeof m.content === "string") return m.content;
				if (Array.isArray(m.content)) {
					return m.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join(" ");
				}
				return "";
			})
			.filter(Boolean);

		if (userMessages.length > 0) {
			const taskSummary = userMessages.slice(-3).join(" | ").slice(0, 200);
			facts.set("shared:_task", taskSummary);
			shelfRemember(MEMORY_NUGGET, "_task", taskSummary, "shared", "project", "inferred", "temporary");
		}

		const toolCalls = messagesToSummarize
			.filter((m: any) => m.role === "assistant")
			.flatMap((m: any) => {
				if (Array.isArray(m.content)) {
					return m.content.filter((c: any) => c.type === "tool_use");
				}
				return [];
			});

		for (const tc of toolCalls.slice(-20)) {
			const fp = tc.input?.file_path || tc.input?.path;
			if (fp && typeof fp === "string") {
				const basename = fp.split("/").pop() || fp;
				const toolName = tc.name || "";
				if (["edit", "write"].includes(toolName)) {
					facts.set(`shared:edited:${basename}`, fp);
				} else if (toolName === "read") {
					facts.set(`shared:file:${basename}`, fp);
				}
			}
		}

		return;
	});

	// -------------------------------------------------------------------
	// Post-compaction + promotion
	// -------------------------------------------------------------------

	pi.on("session_compact", async (_event, _ctx) => {
		// Promote high-recall facts to MEMORY.md
		try {
			promoteFacts(shelf);
		} catch {
			// Non-critical — don't break compaction
		}
	});
}

// ---------------------------------------------------------------------------
// UI component for /donna command
// ---------------------------------------------------------------------------

class DonnaListComponent {
	private facts: Fact[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(facts: Fact[], theme: Theme, onClose: () => void) {
		this.facts = facts;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Donna Memory ");
		const headerLine = th.fg("borderMuted", "\u2500".repeat(3)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 20)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.facts.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No facts stored. Ask the agent to remember something!")}`, width));
		} else {
			const selfFacts = this.facts.filter((f) => f.key.startsWith("self:"));
			const userFacts = this.facts.filter((f) => f.key.startsWith("user:"));
			const sharedFacts = this.facts.filter((f) => f.key.startsWith("shared:") || f.key.startsWith("project:") || f.key.startsWith("_"));

			lines.push(truncateToWidth(`  ${th.fg("muted", `${this.facts.length} facts total`)}`, width));
			lines.push("");

			if (selfFacts.length) {
				lines.push(truncateToWidth(`  ${th.fg("accent", "Assistant Self")}`, width));
				for (const f of selfFacts) {
					lines.push(truncateToWidth(`    ${th.fg("dim", stripScopePrefix(f.key))}: ${th.fg("text", f.value)}`, width));
				}
				lines.push("");
			}

			if (userFacts.length) {
				lines.push(truncateToWidth(`  ${th.fg("accent", "User Memory")}`, width));
				for (const f of userFacts) {
					lines.push(truncateToWidth(`    ${th.fg("dim", stripScopePrefix(f.key))}: ${th.fg("text", f.value)}`, width));
				}
				lines.push("");
			}

			if (sharedFacts.length) {
				lines.push(truncateToWidth(`  ${th.fg("accent", "Shared Context")}`, width));
				for (const f of sharedFacts.slice(-10)) {
					const icon = f.key.includes("edited:") ? th.fg("warning", "\u270e") : th.fg("dim", "\u25cb");
					lines.push(truncateToWidth(`    ${icon} ${th.fg("text", f.value)}`, width));
				}
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
