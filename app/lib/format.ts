import type { EmailAddress } from "../../shared/api";

const sameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Thread-list date, Gmail style: "3:04 PM" today, "Oct 30" this year, "10/30/25" before. */
export function formatListDate(ms: number, now = new Date()): string {
	const d = new Date(ms);
	if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return d.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Message header date: "Oct 30, 2026, 3:04 PM (2 days ago)". */
export function formatMessageDate(ms: number, now = Date.now()): string {
	const full = new Date(ms).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	const diff = ms - now;
	const abs = Math.abs(diff);
	const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
		abs < 3_600_000
			? [Math.round(diff / 60_000), "minute"]
			: abs < 86_400_000
				? [Math.round(diff / 3_600_000), "hour"]
				: abs < 30 * 86_400_000
					? [Math.round(diff / 86_400_000), "day"]
					: [0, "day"];
	return value === 0 && unit === "day" && abs >= 86_400_000 ? full : `${full} (${relative.format(value, unit)})`;
}

export function formatFullDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Display name for an address; "me" for the mailbox's own address. */
export function shortName(a: EmailAddress, me: string): string {
	if (a.address === me) return "me";
	if (a.name) return a.name.split(/\s+/)[0]!.replace(/[",]/g, "") || a.address;
	return a.address.split("@")[0]!;
}

export function fullName(a: EmailAddress, me?: string): string {
	if (me && a.address === me) return "me";
	return a.name || a.address;
}

/** Thread-list sender column: "Alice, Bob, me" (shortened) or a single full name. */
export function participantsLabel(participants: EmailAddress[], me: string): string {
	if (participants.length === 0) return "(no sender)";
	if (participants.length === 1) return fullName(participants[0]!, me);
	const names = participants.map((p) => shortName(p, me));
	return names.length > 3 ? `${names[0]} .. ${names.slice(-2).join(", ")}` : names.join(", ");
}

export function initial(a: EmailAddress): string {
	return (a.name || a.address).trim().charAt(0).toUpperCase() || "?";
}

const AVATAR_COLORS = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#12858a", "#c5221f", "#b06000", "#5f6368"];

export function avatarColor(address: string): string {
	let h = 0;
	for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function recipientsSummary(m: { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] }, me: string): string {
	const all = [...m.to, ...m.cc, ...m.bcc];
	if (all.length === 0) return "undisclosed recipients";
	return `to ${all.map((a) => shortName(a, me)).join(", ")}`;
}
