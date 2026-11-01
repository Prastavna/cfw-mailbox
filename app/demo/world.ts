import type { Domain, EmailAddress, Mailbox, MailboxAccess, Member } from "../../shared/api";
import { AI_PROVIDERS, type AiSettings } from "../../shared/extensions";
import { seedAttachmentFile } from "./files";
import { DEMO_DOMAINS, DEMO_USER, EXTRA_MEMBERS, LIVE_MAIL, type Person, SEED_MAILBOXES, type SeedMailbox } from "./seed";
import { DemoMailbox, HttpError, type StoredAttachment, type StoredMessage, uid } from "./store";

/** Everything the fake backend knows: the directory, each mailbox, and the user's AI settings. */
export class DemoWorld {
	readonly user = DEMO_USER;
	domains: Domain[] = [];
	mailboxes = new Map<string, { info: Mailbox; store: DemoMailbox }>();
	members: Member[] = [];
	ai: AiSettings = {
		enabled: true,
		provider: "workers-ai",
		model: AI_PROVIDERS["workers-ai"].defaultModel,
		baseUrl: null,
		hasKey: false,
		keyHint: null,
		canStoreKeys: true,
	};
	/** Threads that already got a simulated answer, so each conversation gets one. */
	private answered = new Set<string>();
	summaries = new Map<string, string>();

	constructor() {
		const created = Date.now() - 90 * 86_400_000;
		this.domains = DEMO_DOMAINS.map((domain) => ({ domain, createdAt: created }));
		for (const seed of SEED_MAILBOXES) this.seedMailbox(seed, created);
		for (const m of EXTRA_MEMBERS) this.members.push({ mailboxId: m.mailboxId, userEmail: m.email, role: m.role, createdAt: created });
		setInterval(() => {
			for (const { store } of this.mailboxes.values()) store.tick();
		}, 10_000);
	}

	get isReady() {
		const p = AI_PROVIDERS[this.ai.provider];
		return !!this.ai.model && (!p.needsKey || this.ai.hasKey) && (!p.needsBaseUrl || !!this.ai.baseUrl);
	}

	// ---- Directory ------------------------------------------------------------

	accessible(): MailboxAccess[] {
		return [...this.mailboxes.values()]
			.map((m) => ({ ...m.info, role: "owner" as const }))
			.sort((a, b) => a.domain.localeCompare(b.domain) || a.address.localeCompare(b.address));
	}

	mailbox(id: string): DemoMailbox {
		const m = this.mailboxes.get(id);
		if (!m) throw new HttpError(404, "Mailbox not found");
		return m.store;
	}

	addDomain(raw: string): Domain {
		const domain = raw.trim().toLowerCase();
		if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new HttpError(400, "Invalid domain");
		if (this.domains.some((d) => d.domain === domain)) throw new HttpError(409, `Domain ${domain} already exists`);
		const d = { domain, createdAt: Date.now() };
		this.domains.push(d);
		this.domains.sort((a, b) => a.domain.localeCompare(b.domain));
		return d;
	}

	removeDomain(domain: string) {
		if ([...this.mailboxes.values()].some((m) => m.info.domain === domain)) throw new HttpError(409, `Domain ${domain} still has mailboxes`);
		const before = this.domains.length;
		this.domains = this.domains.filter((d) => d.domain !== domain);
		if (before === this.domains.length) throw new HttpError(404, `Domain ${domain} not found`);
	}

	createMailbox(input: { address: string; displayName: string; ownerEmail?: string }): Mailbox {
		const address = input.address.trim().toLowerCase();
		const domain = address.split("@")[1] ?? "";
		if (!domain) throw new HttpError(400, "Invalid email address");
		if (!this.domains.some((d) => d.domain === domain)) throw new HttpError(400, `Add the domain ${domain} before creating mailboxes on it`);
		if ([...this.mailboxes.values()].some((m) => m.info.address === address)) throw new HttpError(409, `Mailbox ${address} already exists`);
		const info: Mailbox = { id: `mbx-${uid().slice(0, 8)}`, address, domain, displayName: input.displayName.trim(), createdAt: Date.now() };
		this.addStore(info);
		if (input.ownerEmail) this.setMember(info.id, input.ownerEmail, "owner");
		return info;
	}

	deleteMailbox(id: string) {
		if (!this.mailboxes.delete(id)) throw new HttpError(404, "Mailbox not found");
		this.members = this.members.filter((m) => m.mailboxId !== id);
	}

	listMembers(mailboxId: string): Member[] {
		return this.members.filter((m) => m.mailboxId === mailboxId).sort((a, b) => a.userEmail.localeCompare(b.userEmail));
	}

	setMember(mailboxId: string, email: string, role: "owner" | "member"): Member {
		this.mailbox(mailboxId);
		const userEmail = email.trim().toLowerCase();
		const existing = this.members.find((m) => m.mailboxId === mailboxId && m.userEmail === userEmail);
		if (existing) {
			existing.role = role;
			return existing;
		}
		const row = { mailboxId, userEmail, role, createdAt: Date.now() };
		this.members.push(row);
		return row;
	}

	removeMember(mailboxId: string, email: string) {
		const before = this.members.length;
		this.members = this.members.filter((m) => !(m.mailboxId === mailboxId && m.userEmail === email.toLowerCase()));
		if (before === this.members.length) throw new HttpError(404, "Member not found");
	}

	// ---- Mail flow ----------------------------------------------------------------

	private addStore(info: Mailbox): DemoMailbox {
		const store = new DemoMailbox(info.id, info.address, info.displayName);
		store.onSent = (m) => this.afterSend(store, m);
		this.mailboxes.set(info.id, { info, store });
		return store;
	}

	/**
	 * Sent mail goes nowhere real. Mail to another demo mailbox is delivered there;
	 * anyone else writes back once, so the conversation shows a reply arriving.
	 */
	private afterSend(sender: DemoMailbox, m: StoredMessage) {
		const recipients = [...m.to, ...m.cc, ...m.bcc];
		for (const r of recipients) {
			const local = [...this.mailboxes.values()].find((x) => x.info.address === r.address.toLowerCase());
			if (local && local.store !== sender) {
				setTimeout(() => local.store.receive({ from: sender.me, to: m.to, cc: m.cc, subject: m.subject, html: m.html ?? undefined, attachments: m.attachments }), 1500);
			}
		}
		const external = recipients.find((r) => ![...this.mailboxes.values()].some((x) => x.info.address === r.address.toLowerCase()));
		if (!external || this.answered.has(m.threadId)) return;
		this.answered.add(m.threadId);
		const first = (external.name || external.address).split(/[\s@]/)[0];
		setTimeout(() => {
			sender.receive({
				from: external,
				to: [sender.me],
				subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
				text: `Thanks ${sender.displayName.split(" ")[0]} — got it! I'll take a look and get back to you.\n\n${first}\n\n(This reply was simulated by the demo. Nothing you send here leaves your browser.)`,
			});
		}, 9000);
	}

	/** Drips a few new messages into the inbox while the demo is open. */
	startLiveMail() {
		LIVE_MAIL.forEach((mail, i) => {
			setTimeout(
				() => {
					const box = this.mailboxes.get(mail.mailboxId);
					if (box) box.store.receive({ from: person(mail.from), to: [box.store.me], subject: mail.subject, text: mail.text });
				},
				25_000 + i * 90_000,
			);
		});
	}

	// ---- Seeding ------------------------------------------------------------------------

	private seedMailbox(seed: SeedMailbox, created: number) {
		const domain = seed.address.split("@")[1]!;
		const store = this.addStore({ id: seed.id, address: seed.address, domain, displayName: seed.displayName, createdAt: created });
		store.settings.signature = seed.signature;
		const labelIds = new Map<string, string>();
		for (const l of seed.labels) labelIds.set(l.name, store.createLabel(l.name, l.color).id);

		const now = Date.now();
		let fileSeed = 0;
		seed.threads.forEach((t, ti) => {
			const threadId = `${seed.id}-t${ti + 1}`;
			store.threads.set(threadId, { id: threadId, bumpedAt: 0, snoozedUntil: t.snoozeHours ? now + t.snoozeHours * 3_600_000 : null });
			if (t.summary) this.summaries.set(threadId, t.summary);
			const userLabels = t.labels.flatMap((l) => (labelIds.has(l) ? [labelIds.get(l)!] : []));
			const has = (l: string) => t.labels.includes(l);
			const latestReceived = t.messages.map((m, i) => (m.from ? i : -1)).filter((i) => i >= 0).at(-1);

			t.messages.forEach((sm, mi) => {
				const at = now - sm.hoursAgo * 3_600_000;
				const mine = sm.from === null;
				const isDraft = !!t.draft && mine && mi === t.messages.length - 1;
				const labels = new Set<string>(userLabels);
				if (has("IMPORTANT")) labels.add("IMPORTANT");
				if (has("TRASH")) labels.add("TRASH");
				if (has("SPAM") && !mine) labels.add("SPAM");
				if (isDraft) labels.add("DRAFT");
				else if (mine) labels.add("SENT");
				if (!mine && has("INBOX")) labels.add(t.snoozeHours ? "SNOOZED" : "INBOX");
				if (mi === latestReceived) {
					if (t.unread) labels.add("UNREAD");
					if (has("STARRED")) labels.add("STARRED");
				}
				const attachments: StoredAttachment[] = (sm.attachments ?? []).map((a) => {
					const file = seedAttachmentFile(a, ++fileSeed + ti);
					const size = Math.floor(((file.dataUrl.length - file.dataUrl.indexOf(",") - 1) * 3) / 4);
					return { id: `att-${ti}-${mi}-${fileSeed}`, filename: a.filename, mimeType: file.mimeType, size, contentId: null, disposition: "attachment", dataUrl: file.dataUrl };
				});
				const from: EmailAddress = mine ? store.me : person(sm.from!);
				const to = sm.to?.map(person) ?? [store.me];
				const cc = sm.cc?.map(person) ?? [];
				store.messages.set(`${threadId}-m${mi + 1}`, {
					id: `${threadId}-m${mi + 1}`,
					threadId,
					messageId: isDraft ? null : `${threadId}-m${mi + 1}@${(from.address.split("@")[1] ?? "example.com")}`,
					from,
					to,
					cc,
					bcc: [],
					subject: mi === 0 ? t.subject : `Re: ${t.subject.replace(/^re:\s*/i, "")}`,
					text: sm.text ?? (sm.html ? htmlToPlain(sm.html) : null),
					html: sm.html ?? null,
					sentAt: at,
					receivedAt: at,
					labels,
					attachments,
					authResults: mine ? null : { spf: "pass", dkim: "pass", dmarc: "pass" },
					hasRaw: !mine,
					sendAt: null,
					sendError: null,
				});
				if (mine) store.recordContacts([...to, ...cc], "sent", at);
				else store.recordContacts([from], "received", at);
			});
		});
	}
}

const person = ([name, address]: Person): EmailAddress => ({ name, address });

function htmlToPlain(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	return (doc.body.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
