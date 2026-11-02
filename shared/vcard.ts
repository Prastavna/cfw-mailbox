/**
 * vCard (.vcf) reading and writing for the address book: enough of RFC 6350 / 2426 (and the
 * 2.1 dialect older exporters still write) to move names, emails, phones, companies and notes
 * between Mail, Google Contacts, Apple Contacts and Outlook.
 */
import type { SavedContact, SavedContactInput } from "./api";

export interface VCardContact {
	name: string;
	emails: string[];
	phone: string;
	company: string;
	notes: string;
}

/** Undoes line folding: a line starting with a space or tab continues the previous one. */
function unfold(text: string): string[] {
	const out: string[] = [];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
		else out.push(line);
	}
	return out;
}

/** vCard 2.1 quoted-printable, including soft line breaks (a line ending in "="). */
function joinSoftBreaks(lines: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i]!;
		if (/ENCODING=QUOTED-PRINTABLE/i.test(line.split(":")[0] ?? "")) {
			while (line.endsWith("=") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
		}
		out.push(line);
	}
	return out;
}

function decodeQuotedPrintable(value: string, charset: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const hex = value.slice(i + 1, i + 3);
		if (value[i] === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else bytes.push(value.charCodeAt(i) & 0xff);
	}
	try {
		return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
	} catch {
		return new TextDecoder().decode(new Uint8Array(bytes));
	}
}

function unescapeText(value: string): string {
	return value.replace(/\\([nN,;\\:])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Splits on separators that aren't escaped with a backslash. */
function splitUnescaped(value: string, sep: string): string[] {
	const parts: string[] = [];
	let current = "";
	for (let i = 0; i < value.length; i++) {
		const c = value[i]!;
		if (c === "\\" && i + 1 < value.length) {
			current += c + value[++i];
		} else if (c === sep) {
			parts.push(current);
			current = "";
		} else current += c;
	}
	parts.push(current);
	return parts;
}

interface Property {
	name: string;
	params: Record<string, string>;
	value: string;
}

function parseLine(line: string): Property | null {
	// The value starts at the first colon outside a quoted parameter value.
	let quoted = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === '"') quoted = !quoted;
		else if (line[i] === ":" && !quoted) {
			colon = i;
			break;
		}
	}
	if (colon <= 0) return null;
	const [rawName, ...rawParams] = line.slice(0, colon).split(";");
	// "item1.EMAIL" (Apple's grouping) is still an EMAIL.
	const name = rawName!.split(".").pop()!.toUpperCase();
	const params: Record<string, string> = {};
	for (const p of rawParams) {
		const eq = p.indexOf("=");
		if (eq === -1) params.TYPE = [params.TYPE, p].filter(Boolean).join(",");
		else params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
	}
	let value = line.slice(colon + 1);
	if (params.ENCODING?.toUpperCase() === "QUOTED-PRINTABLE") value = decodeQuotedPrintable(value, params.CHARSET ?? "utf-8");
	return { name, params, value };
}

const prefersFirst = (p: Property) => /\bpref\b/i.test(p.params.TYPE ?? "") || p.params.PREF === "1";

/** Every card in a .vcf file. Cards without an email address are kept (with `emails: []`); the caller decides. */
export function parseVCards(text: string): VCardContact[] {
	const cards: VCardContact[] = [];
	let props: Property[] | null = null;
	for (const line of joinSoftBreaks(unfold(text))) {
		const trimmed = line.trim();
		if (/^BEGIN:VCARD$/i.test(trimmed)) {
			props = [];
			continue;
		}
		if (/^END:VCARD$/i.test(trimmed)) {
			if (props) cards.push(toContact(props));
			props = null;
			continue;
		}
		const prop = props && trimmed ? parseLine(trimmed) : null;
		if (prop) props!.push(prop);
	}
	return cards;
}

function toContact(props: Property[]): VCardContact {
	const first = (name: string) => props.find((p) => p.name === name);
	let name = unescapeText(first("FN")?.value ?? "").trim();
	if (!name) {
		// N is Family;Given;Additional;Prefix;Suffix.
		const n = splitUnescaped(first("N")?.value ?? "", ";").map((s) => unescapeText(s).trim());
		name = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(" ");
	}
	const emails = props
		.filter((p) => p.name === "EMAIL")
		.sort((a, b) => Number(prefersFirst(b)) - Number(prefersFirst(a)))
		.map((p) => unescapeText(p.value).trim().replace(/^mailto:/i, "").toLowerCase())
		.filter(Boolean);
	const phone = props.filter((p) => p.name === "TEL").sort((a, b) => Number(prefersFirst(b)) - Number(prefersFirst(a)))[0];
	const org = first("ORG");
	return {
		name,
		emails: [...new Set(emails)],
		phone: phone ? unescapeText(phone.value).replace(/^tel:/i, "").trim() : "",
		company: org
			? splitUnescaped(org.value, ";")
					.map((s) => unescapeText(s).trim())
					.filter(Boolean)
					.join(", ")
			: "",
		notes: unescapeText(first("NOTE")?.value ?? "").trim(),
	};
}

function escapeText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Folds a content line to at most 75 octets, without splitting a UTF-8 character. */
function fold(line: string): string {
	const enc = new TextEncoder();
	const out: string[] = [];
	let current = "";
	let size = 0;
	for (const ch of line) {
		const n = enc.encode(ch).length;
		if (size + n > (out.length ? 74 : 75)) {
			out.push(current);
			current = "";
			size = 0;
		}
		current += ch;
		size += n;
	}
	out.push(current);
	return out.join("\r\n ");
}

/** A .vcf file (vCard 3.0, which every contacts app imports) for these contacts. */
export function toVCards(contacts: (SavedContact | SavedContactInput)[]): string {
	return contacts
		.map((c) => {
			const parts = c.name.trim().split(/\s+/);
			const family = parts.length > 1 ? parts.pop()! : "";
			const lines = [
				"BEGIN:VCARD",
				"VERSION:3.0",
				`FN:${escapeText(c.name || c.emails[0] || "")}`,
				`N:${escapeText(family)};${escapeText(parts.join(" "))};;;`,
				...c.emails.map((e, i) => `EMAIL;TYPE=INTERNET${i === 0 ? ",PREF" : ""}:${escapeText(e)}`),
				...(c.phone ? [`TEL:${escapeText(c.phone)}`] : []),
				...(c.company ? [`ORG:${escapeText(c.company)}`] : []),
				...(c.notes ? [`NOTE:${escapeText(c.notes)}`] : []),
				"END:VCARD",
			];
			return lines.map(fold).join("\r\n");
		})
		.join("\r\n")
		.concat(contacts.length ? "\r\n" : "");
}
