/**
 * Fake mail for the static showcase. Everything here is invented: the people,
 * the companies and the addresses (example.com / example.org are reserved for
 * documentation). Times are relative to when the page loads, so the inbox
 * always looks current.
 */

export const DEMO_USER = { email: "alex@example.com", name: "Alex Rivera" };

export interface SeedMailbox {
	id: string;
	address: string;
	displayName: string;
	role: "owner" | "member";
	signature: string;
	labels: { name: string; color: string | null }[];
	threads: SeedThread[];
}

export type Person = readonly [name: string, address: string];

export interface SeedAttachment {
	filename: string;
	kind: "pdf" | "image" | "text" | "calendar";
	/** Lines of text shown in the generated file. */
	lines?: string[];
	inlineId?: string;
}

export interface SeedMessage {
	/** null: written by this mailbox. */
	from: Person | null;
	to?: Person[];
	cc?: Person[];
	hoursAgo: number;
	text?: string;
	html?: string;
	attachments?: SeedAttachment[];
}

export interface SeedThread {
	subject: string;
	/** System folders (INBOX, SPAM, TRASH…), STARRED/IMPORTANT, and user label names. */
	labels: string[];
	unread?: boolean;
	/** Hours from now until a snoozed conversation returns. */
	snoozeHours?: number;
	/** The last message is an unsent draft. */
	draft?: boolean;
	/** What the demo AI says when asked to summarise this conversation. */
	summary?: string;
	messages: SeedMessage[];
}

// ---- People ------------------------------------------------------------------

const P = {
	priya: ["Priya Natarajan", "priya@northwind.example"],
	marcus: ["Marcus Chen", "marcus.chen@example.net"],
	sofia: ["Sofia García", "sofia@example.com"],
	tom: ["Tom Okafor", "tom@example.com"],
	hannah: ["Hannah Weiss", "hannah.weiss@contoso.example"],
	ops: ["Example Ops", "ops@example.com"],
	billing: ["Fabrikam Billing", "billing@fabrikam.example"],
	design: ["Lena Park", "lena@studio.example"],
	mom: ["Mom", "rivera.family@example.net"],
	jamie: ["Jamie Rivera", "jamie.rivera@example.net"],
	airline: ["Skyway Air", "no-reply@skyway.example"],
	hotel: ["Harbor Hotel Lisbon", "stay@harborhotel.example"],
	newsletter: ["The Edge Weekly", "digest@edgeweekly.example"],
	github: ["Code Host", "notifications@codehost.example"],
	calendar: ["Example Calendar", "calendar@example.com"],
	recruiter: ["Dana Brooks", "dana@talentbridge.example"],
	landlord: ["Kofi Mensah", "kofi.mensah@example.net"],
	spam1: ["Prize Department", "winner@lucky-draw.example"],
	spam2: ["Crypto Gains", "vip@moonshot-coins.example"],
	bank: ["Example Bank", "alerts@bank.example"],
	gym: ["Pulse Fitness", "hello@pulsefit.example"],
	books: ["Paper Lantern Books", "orders@paperlantern.example"],
	cust1: ["Ravi Shah", "ravi@shahdesigns.example"],
	cust2: ["Emily Novak", "emily.novak@example.net"],
	cust3: ["Carlos Mendes", "carlos@mendes.example"],
	cust4: ["Aiko Tanaka", "aiko.tanaka@example.net"],
	cust5: ["Grace Liu", "grace@liu-consulting.example"],
	volunteer: ["Ben Adler", "ben.adler@example.net"],
	press: ["Nora Fields", "nora@techpress.example"],
} as const satisfies Record<string, Person>;

const ALEX: Person = ["Alex Rivera", "alex@example.com"];
const SUPPORT: Person = ["Example Support", "support@example.com"];
const HELLO: Person = ["Example.org", "hello@example.org"];

// ---- HTML templates ---------------------------------------------------------------

const newsletterHtml = (issue: number, items: [title: string, blurb: string][]) => `
<div style="background:#f4f4f5;padding:24px 0;font-family:Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
    <tr><td style="background:#18181b;color:#fafafa;padding:28px 32px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a1a1aa">Issue #${issue}</div>
      <div style="font-size:26px;font-weight:700;margin-top:6px">The Edge Weekly</div>
      <div style="font-size:14px;color:#d4d4d8;margin-top:4px">Serverless, edge computing and the open web — in five minutes.</div>
    </td></tr>
    ${items
			.map(
				([t, b]) => `<tr><td style="padding:22px 32px;border-bottom:1px solid #e4e4e7">
      <div style="font-size:18px;font-weight:600;color:#18181b">${t}</div>
      <div style="font-size:14px;line-height:1.6;color:#3f3f46;margin-top:6px">${b}</div>
      <a href="https://example.com/" style="display:inline-block;margin-top:10px;font-size:13px;color:#f97316;text-decoration:none;font-weight:600">Read more →</a>
    </td></tr>`,
			)
			.join("")}
    <tr><td style="padding:20px 32px;font-size:12px;color:#71717a">You're receiving this because you subscribed at edgeweekly.example. <a href="https://example.com/" style="color:#71717a">Unsubscribe</a></td></tr>
  </table>
</div>`;

const receiptHtml = (company: string, rows: [string, string][], total: string, accent: string) => `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <div style="font-size:22px;font-weight:700;color:${accent}">${company}</div>
  <p style="font-size:15px">Thanks for your payment. Here's your receipt.</p>
  <table width="100%" style="border-collapse:collapse;font-size:14px">
    ${rows.map(([a, b]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e4e4e7">${a}</td><td style="padding:10px 0;border-bottom:1px solid #e4e4e7;text-align:right">${b}</td></tr>`).join("")}
    <tr><td style="padding:12px 0;font-weight:700">Total</td><td style="padding:12px 0;text-align:right;font-weight:700">${total}</td></tr>
  </table>
  <p style="font-size:12px;color:#71717a;margin-top:24px">The PDF invoice is attached. Questions? Just reply to this email.</p>
</div>`;

const flightHtml = `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:580px;margin:0 auto;color:#0f172a">
  <div style="background:#0ea5e9;color:white;padding:20px 24px;border-radius:12px 12px 0 0">
    <div style="font-size:13px;opacity:.85">Booking reference</div>
    <div style="font-size:28px;font-weight:700;letter-spacing:3px">QX7R2M</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:0;padding:20px 24px;border-radius:0 0 12px 12px">
    <table width="100%" style="font-size:14px">
      <tr><td><div style="font-size:30px;font-weight:700">SFO</div><div style="color:#64748b">San Francisco</div></td>
          <td style="text-align:center;color:#94a3b8">✈ SK 214<br/>11h 05m</td>
          <td style="text-align:right"><div style="font-size:30px;font-weight:700">LIS</div><div style="color:#64748b">Lisbon</div></td></tr>
    </table>
    <p style="font-size:14px;margin-top:16px"><b>Departs</b> Thu, 19 Nov · 16:40 &nbsp;·&nbsp; <b>Seat</b> 23A &nbsp;·&nbsp; <b>Bags</b> 1 × 23kg</p>
    <p style="font-size:13px;color:#64748b">Online check-in opens 24 hours before departure.</p>
  </div>
</div>`;

const codeHostHtml = (repo: string, title: string, body: string) => `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328;max-width:620px">
  <p><b>@marcus-chen</b> commented on <a href="https://example.com/" style="color:#0969da">${repo}#212</a>: <b>${title}</b></p>
  <div style="border-left:3px solid #d0d7de;padding:4px 12px;color:#424a53">${body}</div>
  <p style="font-size:12px;color:#59636e">— Reply to this email directly or view it on Code Host.</p>
</div>`;

const quote = (who: string, text: string) => `\n\nOn ${who} wrote:\n> ${text.split("\n").join("\n> ")}`;

// ---- Mailboxes ------------------------------------------------------------------

const alex: SeedMailbox = {
	id: "mbx-alex",
	address: "alex@example.com",
	displayName: "Alex Rivera",
	role: "owner",
	signature: "Alex Rivera\nPlatform Lead · Example Inc.",
	labels: [
		{ name: "Work", color: "#4a86e8" },
		{ name: "Receipts", color: "#16a766" },
		{ name: "Travel", color: "#ffad47" },
		{ name: "Family", color: "#f691b3" },
		{ name: "Newsletters", color: "#a479e2" },
	],
	threads: [
		{
			subject: "Q4 launch plan — final review before Friday",
			labels: ["INBOX", "IMPORTANT", "STARRED", "Work"],
			unread: true,
			summary:
				"Priya wants sign-off on the Q4 launch plan by Friday.\n- Launch moves to 18 Nov so the edge rollout can finish first\n- Marcus owns the migration runbook; Sofia the status page\n- Open question for you: approve the extra two days of load testing?",
			messages: [
				{
					from: P.priya,
					to: [ALEX],
					cc: [P.marcus, P.sofia],
					hoursAgo: 26,
					text: "Hi Alex,\n\nAttached is the near-final launch plan. The big change: we're moving launch day to 18 Nov so the edge rollout can finish first.\n\nOwners:\n• Marcus — migration runbook\n• Sofia — status page and comms\n• Me — customer briefings\n\nCould you review and sign off by Friday?\n\nThanks,\nPriya",
					attachments: [
						{
							filename: "Q4-launch-plan.pdf",
							kind: "pdf",
							lines: ["Q4 Launch Plan", "", "Launch date: 18 November", "Rollout: 5% -> 25% -> 100% over 48h", "Owners: Marcus (runbook), Sofia (comms), Priya (customers)", "Risks: cache warm-up, DNS TTLs"],
						},
					],
				},
				{
					from: P.marcus,
					to: [P.priya, ALEX],
					cc: [P.sofia],
					hoursAgo: 20,
					text: "Runbook draft is in the shared folder. One ask: can we get two extra days of load testing before the 25% step? Last time the cache warm-up surprised us." + quote("Tue, Priya Natarajan <priya@northwind.example>", "Could you review and sign off by Friday?"),
				},
				{
					from: P.priya,
					to: [ALEX],
					cc: [P.marcus, P.sofia],
					hoursAgo: 1.5,
					text: "Alex — the only open question is Marcus's extra two days of load testing. If you're OK with it, I'll update the timeline and send it to the exec team this afternoon.",
				},
			],
		},
		{
			subject: "Your invoice from Fabrikam Cloud — October",
			labels: ["INBOX", "Receipts"],
			unread: true,
			messages: [
				{
					from: P.billing,
					to: [ALEX],
					hoursAgo: 3,
					html: receiptHtml("Fabrikam Cloud", [["Compute — 1,240 vCPU hours", "$372.00"], ["Object storage — 2.1 TB", "$31.50"], ["Egress", "$0.00"]], "$403.50", "#2563eb"),
					attachments: [{ filename: "fabrikam-invoice-2026-10.pdf", kind: "pdf", lines: ["Fabrikam Cloud — Invoice INV-20261031", "", "Compute: $372.00", "Storage: $31.50", "Egress: $0.00", "", "The total is $403.50, due 15 November."] }],
				},
			],
		},
		{
			subject: "Lunch Thursday?",
			labels: ["INBOX"],
			unread: true,
			messages: [
				{
					from: P.sofia,
					to: [ALEX],
					hoursAgo: 0.6,
					text: "Hey! A few of us are trying the new ramen place on 3rd this Thursday around 12:30. Want in? 🍜",
				},
			],
		},
		{
			subject: "[edge-router] Retry budget for upstream timeouts (#212)",
			labels: ["INBOX", "Work"],
			unread: true,
			messages: [
				{
					from: P.github,
					to: [ALEX],
					hoursAgo: 4,
					html: codeHostHtml("example/edge-router", "Retry budget for upstream timeouts", "I think we should cap retries at 10% of requests per minute rather than per-request. Otherwise a slow origin turns into a thundering herd. Benchmarks in the PR description."),
				},
				{
					from: P.github,
					to: [ALEX],
					hoursAgo: 2.2,
					html: codeHostHtml("example/edge-router", "Retry budget for upstream timeouts", "Updated: the budget is now a token bucket per origin. p99 under load dropped from 1.8s to 420ms. Ready for review."),
				},
			],
		},
		{
			subject: "Flight confirmation: San Francisco → Lisbon",
			labels: ["INBOX", "Travel", "IMPORTANT"],
			messages: [
				{
					from: P.airline,
					to: [ALEX],
					hoursAgo: 30,
					html: flightHtml,
					attachments: [{ filename: "boarding-details.ics", kind: "calendar", lines: ["SK 214 SFO-LIS", "Thu 19 Nov 16:40"] }],
				},
			],
		},
		{
			subject: "Reservation confirmed — Harbor Hotel Lisbon",
			labels: ["INBOX", "Travel"],
			messages: [
				{
					from: P.hotel,
					to: [ALEX],
					hoursAgo: 29,
					text: "Dear Alex Rivera,\n\nYour reservation is confirmed.\n\nCheck-in: Fri 20 Nov, from 15:00\nCheck-out: Tue 24 Nov, by 11:00\nRoom: Superior Double, river view\nConfirmation: HHL-55821\n\nWe look forward to welcoming you to Lisbon.\n\nHarbor Hotel Lisbon",
				},
			],
		},
		{
			subject: "Design review: new onboarding screens",
			labels: ["INBOX", "Work"],
			summary:
				"Lena shared the new onboarding mock-ups and wants feedback by Wednesday.\n- Three screens instead of five; domain setup moved to the end\n- You asked for a dark-mode pass; she'll add it\n- Next: Lena books a 30-minute walkthrough",
			messages: [
				{
					from: P.design,
					to: [ALEX],
					hoursAgo: 50,
					text: "Hi Alex,\n\nHere are the new onboarding screens. We went from five steps to three, and moved domain setup to the end so people see their inbox first.\n\nWould love feedback by Wednesday.\n\nLena",
					attachments: [{ filename: "onboarding-v3.png", kind: "image" }],
				},
				{
					from: null,
					to: [P.design],
					hoursAgo: 46,
					text: "These look great — the three-step flow is much clearer. Could we get a dark-mode pass before the walkthrough?\n\nAlex" + quote("Lena Park <lena@studio.example>", "Would love feedback by Wednesday."),
				},
				{
					from: P.design,
					to: [ALEX],
					hoursAgo: 40,
					text: "Absolutely, I'll add dark mode and send a calendar invite for a 30-minute walkthrough.",
				},
			],
		},
		{
			subject: "Thanksgiving plans 🦃",
			labels: ["INBOX", "Family", "STARRED"],
			messages: [
				{
					from: P.mom,
					to: [ALEX],
					cc: [P.jamie],
					hoursAgo: 70,
					text: "Hi sweetheart,\n\nAre you and Jamie both coming for Thanksgiving this year? Your aunt wants to know whether to make two pies or three. (The answer is three.)\n\nLove,\nMom",
				},
				{
					from: P.jamie,
					to: [P.mom, ALEX],
					hoursAgo: 66,
					text: "I'm in! I'll bring the stuffing. Alex, can you pick me up from the station Wednesday night?",
				},
				{
					from: null,
					to: [P.mom, P.jamie],
					hoursAgo: 60,
					text: "Count me in. Jamie — yes, text me your train time. Three pies, obviously.",
				},
			],
		},
		{
			subject: "Exciting Staff Engineer opportunity",
			labels: ["INBOX"],
			messages: [
				{
					from: P.recruiter,
					to: [ALEX],
					hoursAgo: 75,
					text: "Hi Alex,\n\nI came across your talk on edge caching and thought of you for a Staff Engineer role at a fast-growing infrastructure startup (Series B, remote-friendly).\n\nWould you be open to a 20-minute chat next week?\n\nBest,\nDana",
				},
			],
		},
		{
			subject: "The Edge Weekly #142: Durable state at the edge",
			labels: ["INBOX", "Newsletters"],
			unread: true,
			messages: [
				{
					from: P.newsletter,
					to: [ALEX],
					hoursAgo: 9,
					html: newsletterHtml(142, [
						["Durable state at the edge", "Why per-entity actors with embedded SQLite are quietly replacing a lot of database clusters — and where they don't fit."],
						["WebSockets without the servers", "Hibernatable sockets let a single object hold thousands of idle connections for almost nothing."],
						["Email is an API now", "Routing, parsing and sending mail from a few hundred lines of TypeScript."],
					]),
				},
			],
		},
		{
			subject: "The Edge Weekly #141: Cold starts are (mostly) solved",
			labels: ["Newsletters"],
			messages: [
				{
					from: P.newsletter,
					to: [ALEX],
					hoursAgo: 177,
					html: newsletterHtml(141, [
						["Cold starts are (mostly) solved", "Isolates, snapshots and pre-warming: a tour of how platforms got startup time under 5ms."],
						["The case for boring queues", "Most event pipelines need at-least-once delivery and a dead-letter queue. That's it."],
					]),
				},
			],
		},
		{
			subject: "Incident review: elevated 5xx in eu-west (resolved)",
			labels: ["INBOX", "Work", "IMPORTANT"],
			messages: [
				{
					from: P.ops,
					to: [ALEX],
					cc: [P.marcus, P.tom],
					hoursAgo: 52,
					text: "Summary: between 09:12 and 09:41 UTC, 2.3% of requests in eu-west returned 502. Cause: a config push reduced the connection pool on two origins. Rolled back at 09:38.\n\nAction items:\n1. Add pool size to the config linter (Tom)\n2. Canary config pushes per region (Marcus)\n3. Page on 5xx > 1% for 3 minutes (Ops)\n\nPost-mortem doc attached.",
					attachments: [{ filename: "postmortem-eu-west.pdf", kind: "pdf", lines: ["Post-mortem: eu-west 5xx", "", "Duration: 29 minutes", "Impact: 2.3% of requests", "Root cause: connection pool reduced by config push"] }],
				},
				{
					from: P.tom,
					to: [P.ops, ALEX],
					hoursAgo: 49,
					text: "Linter rule is merged. It now rejects pool sizes below 32 for production origins.",
				},
			],
		},
		{
			subject: "Your book order has shipped",
			labels: ["INBOX", "Receipts"],
			messages: [
				{
					from: P.books,
					to: [ALEX],
					hoursAgo: 98,
					text: "Good news! Your order #PL-30981 has shipped.\n\n• Designing Data-Intensive Applications\n• The Pragmatic Programmer\n\nEstimated delivery: Monday.\n\nHappy reading,\nPaper Lantern Books",
				},
			],
		},
		{
			subject: "Rent receipt — November",
			labels: ["Receipts"],
			messages: [
				{
					from: P.landlord,
					to: [ALEX],
					hoursAgo: 20,
					text: "Hi Alex, received November's rent, thanks! Receipt attached. Also, the building's water will be off Tuesday 9–11am for maintenance.\n\nKofi",
					attachments: [{ filename: "rent-receipt-nov.pdf", kind: "pdf", lines: ["Rent receipt", "", "November 2026", "Amount received: $2,150.00"] }],
				},
			],
		},
		{
			subject: "Security alert: new sign-in to your account",
			labels: ["INBOX"],
			messages: [
				{
					from: P.bank,
					to: [ALEX],
					hoursAgo: 12,
					text: "We noticed a new sign-in to your Example Bank account from Chrome on macOS (San Francisco, CA).\n\nIf this was you, there's nothing to do. If not, please reset your password from the app.",
				},
			],
		},
		{
			subject: "1:1 agenda",
			labels: ["INBOX", "Work"],
			messages: [
				{
					from: P.tom,
					to: [ALEX],
					hoursAgo: 22,
					text: "For tomorrow's 1:1 I'd like to talk about:\n\n1. The on-call rotation — can we move to weekly handoffs?\n2. My conference talk proposal\n3. Hiring for the platform team\n\nSee you at 10!",
				},
			],
		},
		{
			subject: "Your membership renews next week",
			labels: ["INBOX"],
			snoozeHours: 50,
			messages: [
				{
					from: P.gym,
					to: [ALEX],
					hoursAgo: 80,
					text: "Hi Alex, your annual Pulse Fitness membership renews on 8 Nov for $480. Want to switch to monthly? Reply or visit the front desk.",
				},
			],
		},
		{
			subject: "Interview request: the future of email infrastructure",
			labels: ["INBOX"],
			snoozeHours: 6,
			messages: [
				{
					from: P.press,
					to: [ALEX],
					hoursAgo: 34,
					text: "Hi Alex — I'm writing a piece on self-hosted email and would love 15 minutes of your time this week. Would Thursday work?\n\nNora Fields, TechPress",
				},
			],
		},
		{
			subject: "Re: Conference talk proposal",
			labels: ["Work"],
			draft: true,
			messages: [
				{
					from: P.tom,
					to: [ALEX],
					hoursAgo: 27,
					text: "Here's my abstract for the talk: \"Zero-downtime migrations on the edge\". Would you be willing to review it before the CFP closes on the 10th?",
				},
				{
					from: null,
					to: [P.tom],
					hoursAgo: 5,
					html: "<p>Hi Tom,</p><p>Read it twice — the structure is great. Two suggestions: lead with the incident story, and cut the history section to one slide so you have time for the demo.</p>",
				},
			],
		},
		{
			subject: "Team offsite — venue options",
			labels: ["Work"],
			draft: true,
			messages: [{ from: null, to: [P.priya, P.marcus], hoursAgo: 18, html: "<p>Hi both,</p><p>Shortlist for the offsite so far:</p><ul><li>Lakeside lodge (sleeps 14)</li><li>City co-working loft</li></ul><p>" }],
		},
		{
			subject: "Weekly platform update",
			labels: ["Work"],
			messages: [
				{
					from: null,
					to: [P.priya, P.marcus, P.sofia, P.tom],
					hoursAgo: 28,
					text: "Hi team,\n\nThis week:\n• Edge rollout reached 60% of regions\n• Retry budget PR (#212) nearly ready\n• eu-west incident review done; linter rule merged\n\nNext week: load testing for the Q4 launch.\n\nAlex",
				},
			],
		},
		{
			subject: "Re: Volunteer day sign-ups",
			labels: [],
			messages: [
				{ from: P.volunteer, to: [ALEX], hoursAgo: 140, text: "We still need two more people for the park clean-up on Saturday. Can you make it?" },
				{ from: null, to: [P.volunteer], hoursAgo: 138, text: "Yes — sign me up! I'll bring gloves." },
			],
		},
		{
			subject: "Photos from the weekend 📸",
			labels: ["Family"],
			messages: [
				{
					from: P.jamie,
					to: [ALEX],
					hoursAgo: 120,
					text: "Finally sorted the photos from the hike. The one at the summit came out great!",
					attachments: [{ filename: "summit.png", kind: "image" }],
				},
			],
		},
		{
			subject: "Payment received — thank you",
			labels: ["Receipts"],
			messages: [
				{
					from: P.billing,
					to: [ALEX],
					hoursAgo: 720,
					html: receiptHtml("Fabrikam Cloud", [["Compute — 1,102 vCPU hours", "$330.60"], ["Object storage — 2.0 TB", "$30.00"]], "$360.60", "#2563eb"),
				},
			],
		},
		{
			subject: "CONGRATULATIONS!!! You have been selected",
			labels: ["SPAM"],
			unread: true,
			messages: [{ from: P.spam1, to: [ALEX], hoursAgo: 15, text: "Dear Winner, you have been selected to receive a $1,000 gift card. Click here to claim within 24 hours!!!" }],
		},
		{
			subject: "Turn $100 into $10,000 this week",
			labels: ["SPAM"],
			messages: [{ from: P.spam2, to: [ALEX], hoursAgo: 40, text: "Exclusive VIP signal group. Guaranteed returns. Limited spots." }],
		},
		{
			subject: "Old meeting notes",
			labels: ["TRASH"],
			messages: [{ from: P.marcus, to: [ALEX], hoursAgo: 200, text: "Notes from last month's planning — superseded by the new doc." }],
		},
	],
};

const support: SeedMailbox = {
	id: "mbx-support",
	address: "support@example.com",
	displayName: "Example Support",
	role: "member",
	signature: "— The Example Support team",
	labels: [
		{ name: "Bug", color: "#fb4c2f" },
		{ name: "Billing", color: "#16a766" },
		{ name: "Feature request", color: "#4a86e8" },
	],
	threads: [
		{
			subject: "Can't verify my domain",
			labels: ["INBOX", "Bug", "IMPORTANT"],
			unread: true,
			messages: [
				{
					from: P.cust1,
					to: [SUPPORT],
					hoursAgo: 2,
					text: "Hi, I added the TXT record two hours ago but the dashboard still says \"pending\". Screenshot attached. Is something stuck?\n\nRavi",
					attachments: [{ filename: "dns-screenshot.png", kind: "image" }],
				},
			],
		},
		{
			subject: "Charged twice this month",
			labels: ["INBOX", "Billing"],
			unread: true,
			messages: [
				{
					from: P.cust2,
					to: [SUPPORT],
					hoursAgo: 5,
					text: "Hello, my card was charged $29 twice on Oct 31. Could you refund the duplicate? Invoice numbers are in the attached statement.",
					attachments: [{ filename: "statement.pdf", kind: "pdf", lines: ["Card statement", "", "31 Oct  EXAMPLE INC  $29.00", "31 Oct  EXAMPLE INC  $29.00"] }],
				},
			],
		},
		{
			subject: "Feature request: shared labels",
			labels: ["INBOX", "Feature request"],
			messages: [
				{ from: P.cust3, to: [SUPPORT], hoursAgo: 30, text: "Would love it if labels could be shared across mailboxes in the same domain. Our team uses the same set everywhere." },
				{ from: null, to: [P.cust3], hoursAgo: 28, text: "Thanks Carlos — great idea. I've added it to our roadmap board and will let you know when there's news.\n\n— The Example Support team" },
			],
		},
		{
			subject: "How do I export my mail?",
			labels: ["INBOX"],
			messages: [
				{ from: P.cust4, to: [SUPPORT], hoursAgo: 46, text: "Is there a way to download everything as a backup?" },
				{ from: null, to: [P.cust4], hoursAgo: 45, text: "Yes! Open Settings → Mailbox → Export, and you'll get a standard .mbox file that Thunderbird, Apple Mail and others can import." },
				{ from: P.cust4, to: [SUPPORT], hoursAgo: 44, text: "Perfect, that worked. Thank you!" },
			],
		},
		{
			subject: "Upgrade to annual plan",
			labels: ["Billing"],
			messages: [{ from: P.cust5, to: [SUPPORT], hoursAgo: 90, text: "We'd like to move our team of 12 to the annual plan. Can you send a quote?" }],
		},
	],
};

const hello: SeedMailbox = {
	id: "mbx-hello",
	address: "hello@example.org",
	displayName: "Example.org",
	role: "owner",
	signature: "",
	labels: [{ name: "Partners", color: "#2da2bb" }],
	threads: [
		{
			subject: "Partnership: open-source sponsorship",
			labels: ["INBOX", "Partners"],
			unread: true,
			messages: [
				{
					from: P.hannah,
					to: [HELLO],
					hoursAgo: 8,
					text: "Hi there,\n\nContoso's open-source office would like to sponsor your project for 2027. Could we set up a call to discuss what would help most — CI minutes, a grant, or engineering time?\n\nHannah Weiss",
				},
			],
		},
		{
			subject: "Website contact form: question about self-hosting",
			labels: ["INBOX"],
			messages: [{ from: P.cust2, to: [HELLO], hoursAgo: 60, text: "Does the self-hosted version support multiple domains? We have three." }],
		},
	],
};

export const SEED_MAILBOXES: SeedMailbox[] = [alex, support, hello];

export const DEMO_DOMAINS = ["example.com", "example.org"];

/** Other people with access to the demo mailboxes, for the admin page. */
export const EXTRA_MEMBERS: { mailboxId: string; email: string; role: "owner" | "member" }[] = [
	{ mailboxId: "mbx-support", email: "sofia@example.com", role: "owner" },
	{ mailboxId: "mbx-support", email: "tom@example.com", role: "member" },
	{ mailboxId: "mbx-hello", email: "sofia@example.com", role: "member" },
];

/** Mail that "arrives" while someone is looking at the demo, to show live updates. */
export const LIVE_MAIL: { mailboxId: string; subject: string; from: Person; text: string }[] = [
	{
		mailboxId: "mbx-alex",
		subject: "Re: Lunch Thursday?",
		from: P.sofia,
		text: "Booked a table for 6 at 12:30. See you there! (This message just arrived over the live WebSocket feed — in the real app it's pushed by the mailbox's Durable Object.)",
	},
	{
		mailboxId: "mbx-alex",
		subject: "Quick question about the retry budget",
		from: P.marcus,
		text: "Do you want the token bucket per origin or per zone? I lean per origin, but happy either way.",
	},
];
