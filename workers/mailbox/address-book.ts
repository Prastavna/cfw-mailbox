/**
 * The mailbox's address book: contacts saved by hand or imported, as opposed to the
 * `contacts` table, which remembers everyone the mailbox has corresponded with.
 * Functions take the mailbox's SQL handle; MailboxDO calls them.
 */
import { ADDRESS_BOOK_LIMITS, type ImportContactsResult, type OtherContact, type SavedContact, type SavedContactInput } from "../../shared/api";
import { isValidAddress, normalizeAddress } from "../../shared/address";
import type { VCardContact } from "../../shared/vcard";
import { fail, ok, type Result } from "../lib/result";

type Row = { id: string; name: string; phone: string; company: string; notes: string; created_at: number; updated_at: number; emails: string };

const SELECT = `SELECT b.*, (SELECT json_group_array(address) FROM (
		SELECT address FROM address_book_emails WHERE contact_id = b.id ORDER BY position)) AS emails
	FROM address_book b`;

const toContact = (r: Row): SavedContact => ({
	id: r.id,
	name: r.name,
	emails: JSON.parse(r.emails) as string[],
	phone: r.phone,
	company: r.company,
	notes: r.notes,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** Escapes LIKE wildcards in a user's query. */
const likeEscape = (q: string) => q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);

/** Trims, lower-cases and de-duplicates; rejects invalid addresses. */
function cleanInput(input: SavedContactInput): Result<SavedContactInput & { phone: string; company: string; notes: string }> {
	const emails = [...new Set(input.emails.map(normalizeAddress).filter(Boolean))];
	const bad = emails.find((e) => !isValidAddress(e));
	if (bad) return fail("invalid", `"${bad}" isn't a valid email address`);
	const name = input.name.trim();
	if (!name && !emails.length) return fail("invalid", "Give the contact a name or an email address");
	if (emails.length > ADDRESS_BOOK_LIMITS.emailsPerContact) return fail("invalid", `At most ${ADDRESS_BOOK_LIMITS.emailsPerContact} email addresses per contact`);
	return ok({
		name: name.slice(0, ADDRESS_BOOK_LIMITS.name),
		emails,
		phone: (input.phone ?? "").trim().slice(0, ADDRESS_BOOK_LIMITS.phone),
		company: (input.company ?? "").trim().slice(0, ADDRESS_BOOK_LIMITS.company),
		notes: (input.notes ?? "").trim().slice(0, ADDRESS_BOOK_LIMITS.notes),
	});
}

export function listSaved(sql: SqlStorage, query = ""): SavedContact[] {
	const q = likeEscape(query);
	return sql
		.exec<Row>(
			`${SELECT}
			 WHERE ?1 = '' OR lower(b.name) LIKE '%' || ?1 || '%' ESCAPE '\\' OR lower(b.company) LIKE '%' || ?1 || '%' ESCAPE '\\'
			    OR EXISTS (SELECT 1 FROM address_book_emails e WHERE e.contact_id = b.id AND e.address LIKE '%' || ?1 || '%' ESCAPE '\\')
			 ORDER BY CASE WHEN b.name = '' THEN 1 ELSE 0 END, lower(b.name), b.created_at`,
			q,
		)
		.toArray()
		.map(toContact);
}

export function getSaved(sql: SqlStorage, id: string): SavedContact | null {
	const row = sql.exec<Row>(`${SELECT} WHERE b.id = ?`, id).toArray()[0];
	return row ? toContact(row) : null;
}

/** An address already saved under another contact. */
function emailTaken(sql: SqlStorage, emails: string[], exceptId: string | null): { address: string; name: string } | null {
	if (!emails.length) return null;
	return (
		sql
			.exec<{ address: string; name: string }>(
				`SELECT e.address, b.name FROM address_book_emails e JOIN address_book b ON b.id = e.contact_id
				 WHERE e.address IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR e.contact_id != ?2) LIMIT 1`,
				JSON.stringify(emails),
				exceptId,
			)
			.toArray()[0] ?? null
	);
}

function writeEmails(sql: SqlStorage, id: string, emails: string[]): void {
	sql.exec("DELETE FROM address_book_emails WHERE contact_id = ?", id);
	emails.forEach((address, position) =>
		sql.exec("INSERT INTO address_book_emails (address, contact_id, position) VALUES (?, ?, ?)", address, id, position),
	);
}

const count = (sql: SqlStorage) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM address_book").one().n;

/** Call inside a transaction. */
export function createSaved(sql: SqlStorage, input: SavedContactInput, now = Date.now()): Result<SavedContact> {
	const clean = cleanInput(input);
	if (!clean.ok) return clean;
	if (count(sql) >= ADDRESS_BOOK_LIMITS.contacts) return fail("invalid", `At most ${ADDRESS_BOOK_LIMITS.contacts} contacts`);
	const taken = emailTaken(sql, clean.value.emails, null);
	if (taken) return fail("conflict", `${taken.address} is already saved${taken.name ? ` as ${taken.name}` : ""}`);
	const id = crypto.randomUUID();
	const { name, phone, company, notes, emails } = clean.value;
	sql.exec(
		"INSERT INTO address_book (id, name, phone, company, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id,
		name,
		phone,
		company,
		notes,
		now,
		now,
	);
	writeEmails(sql, id, emails);
	return ok(getSaved(sql, id)!);
}

/** Call inside a transaction. */
export function updateSaved(sql: SqlStorage, id: string, input: SavedContactInput): Result<SavedContact> {
	if (!getSaved(sql, id)) return fail("not_found", "Contact not found");
	const clean = cleanInput(input);
	if (!clean.ok) return clean;
	const taken = emailTaken(sql, clean.value.emails, id);
	if (taken) return fail("conflict", `${taken.address} is already saved${taken.name ? ` as ${taken.name}` : ""}`);
	const { name, phone, company, notes, emails } = clean.value;
	sql.exec(
		"UPDATE address_book SET name = ?, phone = ?, company = ?, notes = ?, updated_at = ? WHERE id = ?",
		name,
		phone,
		company,
		notes,
		Date.now(),
		id,
	);
	writeEmails(sql, id, emails);
	return ok(getSaved(sql, id)!);
}

/** Call inside a transaction. */
export function deleteSaved(sql: SqlStorage, ids: string[]): number {
	const json = JSON.stringify(ids);
	sql.exec("DELETE FROM address_book_emails WHERE contact_id IN (SELECT value FROM json_each(?))", json);
	return sql.exec("DELETE FROM address_book WHERE id IN (SELECT value FROM json_each(?))", json).rowsWritten;
}

/**
 * Adds cards from a .vcf file. A card sharing an address with a saved contact fills in that
 * contact's blanks and adds its other addresses (unless they belong to someone else).
 * Call inside a transaction.
 */
export function importCards(sql: SqlStorage, cards: VCardContact[]): ImportContactsResult {
	const result: ImportContactsResult = { added: 0, updated: 0, skipped: 0 };
	for (const card of cards) {
		const emails = card.emails.map(normalizeAddress).filter(isValidAddress).slice(0, ADDRESS_BOOK_LIMITS.emailsPerContact);
		if (!emails.length) {
			result.skipped++;
			continue;
		}
		const owner = sql
			.exec<{ contact_id: string }>(
				"SELECT contact_id FROM address_book_emails WHERE address IN (SELECT value FROM json_each(?)) LIMIT 1",
				JSON.stringify(emails),
			)
			.toArray()[0];
		if (owner) {
			const existing = getSaved(sql, owner.contact_id)!;
			const free = emails.filter((e) => !existing.emails.includes(e) && !emailTaken(sql, [e], existing.id));
			const merged: SavedContactInput = {
				name: existing.name || card.name,
				emails: [...existing.emails, ...free].slice(0, ADDRESS_BOOK_LIMITS.emailsPerContact),
				phone: existing.phone || card.phone,
				company: existing.company || card.company,
				notes: existing.notes || card.notes,
			};
			const changed =
				merged.name !== existing.name ||
				merged.emails.length !== existing.emails.length ||
				merged.phone !== existing.phone ||
				merged.company !== existing.company ||
				merged.notes !== existing.notes;
			if (changed && updateSaved(sql, existing.id, merged).ok) result.updated++;
			continue;
		}
		const created = createSaved(sql, { ...card, emails });
		if (created.ok) result.added++;
		else result.skipped++;
	}
	return result;
}

/** People from the mailbox's history who aren't saved, most recent first. */
export function listOther(sql: SqlStorage, query: string, limit: number, exclude: string[]): OtherContact[] {
	const q = likeEscape(query);
	return sql
		.exec<{ name: string; address: string; sent_count: number; received_count: number; last_contacted: number }>(
			`SELECT c.* FROM contacts c
			 WHERE NOT EXISTS (SELECT 1 FROM address_book_emails e WHERE e.address = c.address)
			   AND c.address NOT IN (SELECT value FROM json_each(?2))
			   AND (?1 = '' OR c.address LIKE '%' || ?1 || '%' ESCAPE '\\' OR lower(c.name) LIKE '%' || ?1 || '%' ESCAPE '\\')
			 ORDER BY c.last_contacted DESC
			 LIMIT ?3`,
			q,
			JSON.stringify(exclude),
			limit,
		)
		.toArray()
		.map((r) => ({ name: r.name, address: r.address, sentCount: r.sent_count, receivedCount: r.received_count, lastContacted: r.last_contacted }));
}

/**
 * Recipient suggestions: saved contacts (each of their addresses) and people from the
 * mailbox's history, matching the start of a name, address or domain. Saved contacts come
 * first, then whoever you write to most.
 */
export function suggest(sql: SqlStorage, query: string, limit: number, exclude: string[]): { name: string; address: string }[] {
	const q = likeEscape(query);
	const match = (name: string, address: string) =>
		`(?1 = '' OR ${address} LIKE ?1 || '%' ESCAPE '\\' OR ${address} LIKE '%@' || ?1 || '%' ESCAPE '\\'
		  OR lower(${name}) LIKE ?1 || '%' ESCAPE '\\' OR lower(${name}) LIKE '% ' || ?1 || '%' ESCAPE '\\')`;
	return sql
		.exec<{ name: string; address: string }>(
			`SELECT name, address FROM (
				SELECT b.name, e.address, 0 AS grp, coalesce(c.sent_count, 0) AS sent, coalesce(c.received_count, 0) AS received,
				       coalesce(c.last_contacted, 0) AS last, e.position AS pos
				FROM address_book_emails e JOIN address_book b ON b.id = e.contact_id LEFT JOIN contacts c ON c.address = e.address
				WHERE ${match("b.name", "e.address")}
				UNION ALL
				SELECT c.name, c.address, 1, c.sent_count, c.received_count, c.last_contacted, 0
				FROM contacts c
				WHERE NOT EXISTS (SELECT 1 FROM address_book_emails e WHERE e.address = c.address) AND ${match("c.name", "c.address")}
			)
			WHERE address NOT IN (SELECT value FROM json_each(?2))
			ORDER BY grp, sent DESC, received DESC, last DESC, pos
			LIMIT ?3`,
			q,
			JSON.stringify(exclude),
			limit,
		)
		.toArray();
}

/** Whether this address is a saved contact (for "only reply to my contacts"). */
export function isSaved(sql: SqlStorage, address: string): boolean {
	return sql.exec("SELECT 1 FROM address_book_emails WHERE address = ? LIMIT 1", normalizeAddress(address)).toArray().length > 0;
}
