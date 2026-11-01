import type { SearchQuery, SearchTerm } from "../../shared/search";

/**
 * Compiles a parsed search into SQL over `messages m` (each condition must
 * hold for one message of a thread) plus a thread-level scope from `in:`.
 *
 * Every user value reaches SQL as a bound parameter; text goes to FTS5 as a
 * quoted string, so operators in it are never interpreted.
 */

export interface CompiledSearch {
	/** Conditions on `messages m`, or null when only the scope applies. */
	where: string | null;
	params: (string | number)[];
	/** A label ID the thread must carry; "ALL" (default: not Trash/Spam) or "ANYWHERE". */
	scope: string;
}

export interface SearchContext {
	labels: { id: string; name: string }[];
	now: number;
	/** The browser's `Date#getTimezoneOffset()`, so dates mean the user's local midnight. */
	tzOffsetMinutes: number;
}

const FOLDERS: Record<string, string> = {
	inbox: "INBOX",
	sent: "SENT",
	draft: "DRAFT",
	drafts: "DRAFT",
	spam: "SPAM",
	trash: "TRASH",
	bin: "TRASH",
	starred: "STARRED",
	important: "IMPORTANT",
	all: "ALL",
	anywhere: "ANYWHERE",
	outbox: "OUTBOX",
	scheduled: "OUTBOX",
};

const STATE_LABELS: Record<string, [label: string, present: boolean]> = {
	unread: ["UNREAD", true],
	read: ["UNREAD", false],
	starred: ["STARRED", true],
	unstarred: ["STARRED", false],
	important: ["IMPORTANT", true],
	draft: ["DRAFT", true],
	sent: ["SENT", true],
};

const FTS_COLUMNS: Partial<Record<string, string>> = {
	from: "sender",
	to: "recipients",
	cc: "recipients",
	bcc: "recipients",
	subject: "subject",
	filename: "filenames",
};

const NOTHING = "0";
const DAY_MS = 86_400_000;
const AGE_UNITS: Record<string, number> = { d: DAY_MS, w: 7 * DAY_MS, m: 30 * DAY_MS, y: 365 * DAY_MS };
const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, kb: 1024, m: 1024 * 1024, mb: 1024 * 1024 };

/** An FTS5 expression matching `value` (as a phrase), optionally as a word prefix and limited to a column. */
function ftsExpression(term: SearchTerm, column: string | undefined): string | null {
	// Text with no letters or digits has no tokens, and an empty FTS5 phrase is an error.
	if (!/[\p{L}\p{N}]/u.test(term.value)) return null;
	const quoted = `"${term.value.replace(/"/g, '""')}"${term.phrase ? "" : "*"}`;
	return column ? `${column} : ${quoted}` : quoted;
}

function parseDate(value: string, tzOffsetMinutes: number): number | null {
	const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
	if (!m) return null;
	const [y, mo, d] = m[1]!.length === 4 ? [m[1], m[2], m[3]] : [m[3], m[1], m[2]];
	const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
	return Number.isFinite(ms) ? ms + tzOffsetMinutes * 60_000 : null;
}

function parseAge(value: string): number | null {
	const m = /^(\d{1,5})([dwmy])$/.exec(value);
	return m ? Number(m[1]) * AGE_UNITS[m[2]!]! : null;
}

function parseSize(value: string): number | null {
	const m = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb)?$/.exec(value);
	return m ? Math.round(Number(m[1]) * SIZE_UNITS[m[2] ?? ""]!) : null;
}

const hasLabel = (param: number) => `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?${param})`;

export function compileSearch(query: SearchQuery, ctx: SearchContext): CompiledSearch {
	const params: (string | number)[] = [];
	const bind = (v: string | number) => {
		params.push(v);
		return params.length;
	};

	let scope = "ALL";
	const groups = query.filter((group) => {
		const [t] = group;
		// A plain `in:` picks the folder, like browsing it; negated or OR'd ones are conditions.
		if (group.length === 1 && t!.key === "in" && !t!.negate) {
			const folder = FOLDERS[t!.value] ?? labelId(t!.value, ctx);
			if (folder) {
				scope = folder;
				return false;
			}
		}
		return true;
	});

	const compileTerm = (t: SearchTerm): string => {
		switch (t.key) {
			case null:
			case "from":
			case "to":
			case "cc":
			case "bcc":
			case "subject":
			case "filename": {
				const expr = ftsExpression(t, FTS_COLUMNS[t.key ?? ""]);
				if (!expr) return NOTHING;
				return `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?${bind(expr)})`;
			}
			case "has":
				if (t.value === "attachment" || t.value === "attachments") return "m.has_attachments = 1";
				if (t.value === "userlabels" || t.value === "nouserlabels") {
					const exists = `EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.type = 'user')`;
					return t.value === "userlabels" ? exists : `NOT ${exists}`;
				}
				return NOTHING;
			case "is": {
				const state = STATE_LABELS[t.value];
				if (!state) return NOTHING;
				const cond = hasLabel(bind(state[0]));
				return state[1] ? cond : `NOT ${cond}`;
			}
			case "in":
			case "label": {
				const id = t.key === "in" ? (FOLDERS[t.value] ?? labelId(t.value, ctx)) : labelId(t.value, ctx);
				if (id === "ANYWHERE" || id === "ALL") return "1";
				return id ? hasLabel(bind(id)) : NOTHING;
			}
			case "before":
			case "after": {
				const at = parseDate(t.value, ctx.tzOffsetMinutes);
				if (at === null) return NOTHING;
				// "before:2026/10/02" excludes that day; "after:2026/10/01" includes it.
				return t.key === "before" ? `m.received_at < ?${bind(at)}` : `m.received_at >= ?${bind(at)}`;
			}
			case "older":
			case "newer": {
				const at = parseDate(t.value, ctx.tzOffsetMinutes);
				if (at === null) return NOTHING;
				return t.key === "older" ? `m.received_at < ?${bind(at)}` : `m.received_at >= ?${bind(at)}`;
			}
			case "older_than":
			case "newer_than": {
				const age = parseAge(t.value);
				if (age === null) return NOTHING;
				return t.key === "older_than" ? `m.received_at < ?${bind(ctx.now - age)}` : `m.received_at >= ?${bind(ctx.now - age)}`;
			}
			case "larger":
			case "smaller": {
				const size = parseSize(t.value);
				if (size === null) return NOTHING;
				return t.key === "larger" ? `m.size > ?${bind(size)}` : `m.size < ?${bind(size)}`;
			}
		}
	};

	const conditions = groups.map((group) => {
		const parts = group.map((t) => {
			const sql = compileTerm(t);
			return t.negate ? `NOT (${sql})` : `(${sql})`;
		});
		return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
	});

	return { where: conditions.length ? conditions.join(" AND ") : null, params, scope };
}

/** Finds a user label by name, case-insensitively; Gmail also accepts "-" for spaces and "/" nesting as-is. */
function labelId(name: string, ctx: SearchContext): string | null {
	const wanted = name.toLowerCase();
	const label = ctx.labels.find((l) => {
		const n = l.name.toLowerCase();
		return n === wanted || n.replace(/\s+/g, "-") === wanted;
	});
	return label?.id ?? null;
}
