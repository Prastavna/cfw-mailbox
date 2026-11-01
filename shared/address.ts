/**
 * Email address helpers shared by the Worker and the browser.
 *
 * Addresses are stored lower-cased. That isn't strictly RFC-correct (the local
 * part may be case-sensitive), but every mainstream provider treats it as
 * case-insensitive, and so do we.
 */

// Deliberately loose: real validation happens when the mail system accepts or
// rejects the message. This only catches obvious typos.
const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, "");
}

export function isValidAddress(address: string): boolean {
	return ADDRESS_RE.test(normalizeAddress(address));
}

export function isValidDomain(domain: string): boolean {
	return DOMAIN_RE.test(normalizeDomain(domain));
}

/** The domain part of an address, or "" when there is no "@". */
export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : normalizeDomain(address.slice(at + 1));
}
