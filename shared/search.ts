/**
 * Gmail-style search queries, parsed into terms. Shared by the Worker (which
 * compiles them to SQL) and the browser (which builds queries from the
 * advanced-search form).
 *
 *   budget from:alice -in:trash "launch plan" has:attachment after:2026/10/01
 *   invoice OR receipt
 *
 * Terms are ANDed; `OR` between two terms joins them into a group.
 */

export interface SearchTerm {
	/** Operator such as "from" or "is"; null for plain words. */
	key: SearchKey | null;
	value: string;
	negate: boolean;
	/** Written in double quotes: match the exact phrase, not word prefixes. */
	phrase: boolean;
}

/** AND of OR-groups. */
export type SearchQuery = SearchTerm[][];

export const SEARCH_KEYS = [
	"from",
	"to",
	"cc",
	"bcc",
	"subject",
	"filename",
	"has",
	"is",
	"in",
	"label",
	"before",
	"after",
	"older",
	"newer",
	"older_than",
	"newer_than",
	"larger",
	"smaller",
] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

const KEYS = new Set<string>(SEARCH_KEYS);
export const MAX_QUERY_LENGTH = 500;
const MAX_TERMS = 30;

export function parseSearch(input: string): SearchQuery {
	const q = input.slice(0, MAX_QUERY_LENGTH);
	const groups: SearchQuery = [];
	let joinNext = false;
	let i = 0;

	const readValue = (): { value: string; phrase: boolean } => {
		if (q[i] === '"') {
			const end = q.indexOf('"', i + 1);
			const value = q.slice(i + 1, end === -1 ? q.length : end);
			i = end === -1 ? q.length : end + 1;
			return { value, phrase: true };
		}
		const start = i;
		while (i < q.length && !/\s/.test(q[i]!)) i++;
		return { value: q.slice(start, i), phrase: false };
	};

	while (i < q.length) {
		if (/\s/.test(q[i]!)) {
			i++;
			continue;
		}
		let negate = false;
		if (q[i] === "-" && i + 1 < q.length && !/\s/.test(q[i + 1]!)) {
			negate = true;
			i++;
		}

		let key: SearchKey | null = null;
		const op = /^([a-z_]+):(?=\S)/i.exec(q.slice(i));
		if (op && KEYS.has(op[1]!.toLowerCase())) {
			key = op[1]!.toLowerCase() as SearchKey;
			i += op[0].length;
		}
		let { value, phrase } = readValue();
		if (!phrase) value = value.replace(/^[({]+|[)}]+$/g, "");

		if (!key && !negate && !phrase && (value === "OR" || value === "|")) {
			if (groups.length) joinNext = true;
			continue;
		}
		if (!key && !negate && !phrase && value === "AND") continue;
		if (!value.trim()) continue;

		const term: SearchTerm = { key, value: key && !phrase ? value.toLowerCase() : value, negate, phrase };
		if (joinNext && groups.length) groups.at(-1)!.push(term);
		else groups.push([term]);
		joinNext = false;
		if (groups.flat().length >= MAX_TERMS) break;
	}
	return groups;
}

/** Quotes a value for use in a query when it contains spaces. */
export function quoteSearchValue(value: string): string {
	const v = value.replace(/"/g, "").trim();
	return /\s/.test(v) ? `"${v}"` : v;
}

/** Whether the query explicitly searches Trash or Spam (they're excluded otherwise). */
export function searchesHiddenFolders(query: SearchQuery): boolean {
	return query.some((g) => g.some((t) => t.key === "in" && !t.negate && ["trash", "bin", "spam", "anywhere"].includes(t.value)));
}

/** The advanced-search form, Gmail style. */
export interface SearchFields {
	from: string;
	to: string;
	subject: string;
	hasWords: string;
	doesntHave: string;
	hasAttachment: boolean;
	/** "" for any time, else a newer_than: value such as "7d". */
	within: string;
	/** "" for the default (everything but Spam/Trash), else an in: value or label name. */
	folder: string;
}

export const EMPTY_SEARCH_FIELDS: SearchFields = {
	from: "",
	to: "",
	subject: "",
	hasWords: "",
	doesntHave: "",
	hasAttachment: false,
	within: "",
	folder: "",
};

export function buildSearchQuery(f: SearchFields): string {
	const parts: string[] = [];
	if (f.from.trim()) parts.push(`from:${quoteSearchValue(f.from)}`);
	if (f.to.trim()) parts.push(`to:${quoteSearchValue(f.to)}`);
	if (f.subject.trim()) parts.push(`subject:${quoteSearchValue(f.subject)}`);
	if (f.hasWords.trim()) parts.push(f.hasWords.trim());
	for (const word of f.doesntHave.trim().split(/\s+/).filter(Boolean)) parts.push(`-${word.replace(/^-+/, "")}`);
	if (f.hasAttachment) parts.push("has:attachment");
	if (f.within) parts.push(`newer_than:${f.within}`);
	if (f.folder) parts.push(`in:${quoteSearchValue(f.folder)}`);
	return parts.join(" ");
}

/** Fills the form back from a query; terms the form can't show stay in "has the words". */
export function searchFieldsFrom(query: string): SearchFields {
	const f: SearchFields = { ...EMPTY_SEARCH_FIELDS };
	const words: string[] = [];
	const without: string[] = [];
	const show = (t: SearchTerm) => (t.phrase ? `"${t.value}"` : t.value);
	for (const group of parseSearch(query)) {
		const t = group[0]!;
		if (group.length > 1) {
			words.push(group.map((x) => `${x.negate ? "-" : ""}${x.key ? `${x.key}:` : ""}${show(x)}`).join(" OR "));
			continue;
		}
		if (!t.negate && (t.key === "from" || t.key === "to" || t.key === "subject") && !f[t.key]) f[t.key] = t.value;
		else if (!t.negate && t.key === "has" && t.value === "attachment") f.hasAttachment = true;
		else if (!t.negate && t.key === "newer_than" && !f.within) f.within = t.value;
		else if (!t.negate && t.key === "in" && !f.folder) f.folder = t.value;
		else if (t.negate && !t.key && !t.phrase) without.push(t.value);
		else words.push(`${t.negate ? "-" : ""}${t.key ? `${t.key}:` : ""}${show(t)}`);
	}
	f.hasWords = words.join(" ");
	f.doesntHave = without.join(" ");
	return f;
}
