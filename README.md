# cfw-mailbox

Self-hosted, Gmail-style webmail that runs entirely on your own Cloudflare account. Inspired by Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox).

- **Receive** with [Email Routing](https://developers.cloudflare.com/email-routing/), **send** with [Email Service](https://developers.cloudflare.com/email-service/).
- **Each mailbox** lives in its own SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/). Raw messages and attachments are stored in [R2](https://developers.cloudflare.com/r2/).
- **Many users, many domains.** Admins add domains and mailboxes and grant people access. Each user switches between the mailboxes they're allowed to open.
- **Sign-in** uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). The Worker verifies every request's Access token itself and enforces per-mailbox permissions.

> Status: **Phase 8 (hardening)**. Mail is received, threaded and readable; you can archive, delete, report spam, mark read or unread, star and label it, with undo. You can write new messages, reply, reply all and forward in Gmail-style compose windows, with rich text, attachments, auto-saved drafts, a signature and undo send. Search covers every message with Gmail's operators. You can snooze conversations, set up filters and a vacation responder, get recipient suggestions from your contacts, and use Gmail's keyboard shortcuts. Trash and Spam empty themselves after 30 days. Each mailbox can be downloaded as an mbox file. Admins manage domains, mailboxes and members at `/admin`. AI features (Phase 7) are on hold.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/cfw-mailbox)

## Stack

React 19 + React Router (framework mode) · Tailwind v4 + shadcn/ui · TanStack Query · Hono + Zod · Durable Objects (SQLite) + Drizzle · R2 · Vitest in the Workers runtime.

## Layout

```
app/                 React UI
  routes/            / → last mailbox; /mail/:mailboxId/:folder[/:threadId]
  components/mail/   Header, account switcher, sidebar, thread list, conversation view
    compose/         Compose windows, TipTap editor, recipient chips
  lib/email-html.ts  Sanitises HTML mail for a sandboxed iframe (DOMPurify + CSP)
  lib/compose*.ts    Reply recipients, quoting, signature; compose window store
  lib/shortcuts.ts   Keyboard shortcuts
shared/              Types and helpers used by both browser and Worker
workers/
  app.ts             Worker entry: /api → Hono, everything else → React Router
  api/               HTTP API
  auth/access.ts     Cloudflare Access JWT verification (+ local dev mode)
  registry/          RegistryDO: domains, mailboxes, members (one global instance)
  mailbox/           MailboxDO: one per mailbox; threads, messages, labels, drafts, outbox,
                     search, snooze, contacts, filters, vacation replies, Trash purge
  email/inbound.ts   Email Routing handler
  email/outbound.ts  Builds Email Service payloads; explains send errors
  email/export.ts    mbox export (mbox.ts: mboxrd escaping; mime.ts: rebuilds sent mail)
  lib/security-headers.ts  Headers added to every response
test/                Vitest tests that run in workerd (fixtures/: mail as real clients send it)
e2e/                 Playwright tests against `pnpm dev`
```

## Local development

```bash
pnpm install
pnpm dev
```

`pnpm dev` signs you in as `dev@example.com`, an admin, without Cloudflare Access (dev sign-in only works on `localhost`). To use another address, create `.dev.vars` with `DEV_USER_EMAIL=you@example.com` and `ADMIN_EMAILS=you@example.com`. Open <http://localhost:5173/admin> to add a domain and a mailbox, or use the admin API:

```bash
curl -X POST localhost:5173/api/admin/domains   -H 'content-type: application/json' -d '{"domain":"example.com"}'
curl -X POST localhost:5173/api/admin/mailboxes -H 'content-type: application/json' \
  -d '{"address":"hello@example.com","displayName":"Hello"}'
```

Sending is **simulated** in local dev: nothing leaves your machine, and wrangler logs each message and writes its parts under `.wrangler/tmp/email/`. To send real mail from `pnpm dev`, add `"remote": true` to the `send_email` binding in `wrangler.jsonc` (the sending domain must be onboarded to Email Service).

Checks:

```bash
pnpm test                 # unit and integration tests in workerd
pnpm run typecheck
pnpm run build
pnpm exec playwright install chromium   # once
pnpm test:e2e             # end-to-end, against its own `pnpm dev` on port 5180
```

The end-to-end tests keep their data in `.wrangler/e2e-state` and create a fresh mailbox per test, so they never touch your dev mail. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a Chromium you already have.

## Deploying (self-hosting)

### With the button

1. Click **Deploy to Cloudflare** above. It forks the repository into your GitHub or GitLab account, creates the R2 bucket and Durable Objects, and deploys the Worker. It asks for `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAILS`; you can leave the Access values empty for now and set them in step 2.
2. Continue from step 2 below.

### By hand

1. `npx wrangler r2 bucket create cfw-mailbox`, then `pnpm run deploy`.
2. **Protect it with Access.** Enable [one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on the Worker, then set the secrets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (`npx wrangler secret put ACCESS_AUD`, or in the dashboard) from the values it shows. Until both are set, the API refuses every request.
3. Set the secret `ADMIN_EMAILS` to the people who manage domains and mailboxes (comma-separated).
4. For each domain, enable **Email Routing** and add a catch-all rule that sends to this Worker. Mail to addresses that have no mailbox is rejected.
5. Enable **Email Service** sending for each domain (`npx wrangler email sending enable example.com`). Until a domain is onboarded, sending from it fails with a message saying so, and the draft stays in Drafts.

`.dev.vars.example` lists the secrets. Workers Builds and the Deploy button keep redeploying from your repository's default branch.

## Security

- **Sign-in:** every API request must carry a valid Cloudflare Access token for this application, checked by the Worker itself; mailbox access is then checked per mailbox, and unknown or forbidden mailboxes answer 404.
- **Cross-site requests:** state-changing requests must be JSON (which forces a CORS preflight) and come from the app's own origin; WebSocket upgrades must too.
- **Pages** are sent with a per-request nonce Content Security Policy (no inline scripts without the nonce, no framing, no plugins) and `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and, over HTTPS, HSTS. Static files get the same via `public/_headers`.
- **Mail content** is sanitised and shown in a sandboxed iframe with its own stricter policy (see *Reading mail safely*). Attachments and "Show original" are served with `nosniff` and a sandboxing CSP, and only images display inline.

## Limits

| What | Limit |
|---|---|
| Incoming message | 25 MiB (Email Routing's cap); larger mail is rejected |
| Outgoing message | 50 recipients, 32 attachments, 25 MB (Email Service) |
| API requests | 600 a minute per user |
| Sends, uploads, exports | 30 a minute per user |
| JSON request body | 1 MiB (a draft's HTML is capped at 300 KB) |
| Mailbox database | about 9 GiB of the Durable Object's 10 GB; past that, new mail is bounced with "Mailbox is full" |

Request budgets use the [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): they're counted per Cloudflare location and approximate, a guard against runaway scripts rather than a quota. Change them under `ratelimits` in `wrangler.jsonc`. Attachments and raw messages live in R2 and don't count towards the database size; Settings → General shows both.

## Backups and export

- **Download all mail** (Settings → General) streams the whole mailbox as an [mboxrd](https://en.wikipedia.org/wiki/Mbox) file that Thunderbird, Apple Mail and most migration tools import. Received mail is exported byte for byte; mail sent from here is rebuilt from what's stored (Email Service doesn't hand back the raw message). Each message carries an `X-Mailbox-Labels` header. Unsent drafts are left out.
- **R2** keeps the original `.eml` of every received message under `mailboxes/<id>/messages/`. Turn on [bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) if you want deletions to be impossible for a retention period.
- **Durable Objects** (the mailbox databases) are stored by Cloudflare with [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/storage-api/#pitr-point-in-time-recovery-api) for the last 30 days. The app doesn't expose restores; for now, keep regular mbox exports.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/health` | anyone |
| GET | `/api/me` | signed in |
| GET/POST/DELETE | `/api/admin/domains[/:domain]` | admin |
| GET/POST/DELETE | `/api/admin/mailboxes[/:id]` | admin |
| GET/PUT/DELETE | `/api/admin/mailboxes/:id/members[/:email]` | admin |
| GET | `/api/mailboxes/:id/labels` | mailbox member (with total/unread counts) |
| GET | `/api/mailboxes/:id/threads?label=INBOX&cursor=&limit=` | mailbox member |
| GET | `/api/mailboxes/:id/threads?q=from:alice budget&tz=-60` | mailbox member (search; `tz` is the browser's timezone offset) |
| GET | `/api/mailboxes/:id/threads/:threadId` | mailbox member |
| GET | `/api/mailboxes/:id/messages/:messageId/attachments/:attachmentId[?inline=1]` | mailbox member |
| GET | `/api/mailboxes/:id/messages/:messageId/raw` | mailbox member ("Show original") |
| GET (WebSocket) | `/api/mailboxes/:id/events` | mailbox member: pushes `threads.changed` |
| POST | `/api/mailboxes/:id/threads/modify` `{threadIds, addLabelIds, removeLabelIds}` | mailbox member |
| POST | `/api/mailboxes/:id/messages/modify` `{changes: [{messageId, addLabelIds, removeLabelIds}]}` | mailbox member (per-message changes and undo) |
| POST | `/api/mailboxes/:id/threads/delete` `{threadIds}` | mailbox member (Trash/Spam only, permanent) |
| POST/PATCH/DELETE | `/api/mailboxes/:id/labels[/:labelId]` | mailbox member (user labels) |
| GET/PATCH | `/api/mailboxes/:id/settings` `{signature, undoSendSeconds, vacation}` | mailbox member |
| GET | `/api/mailboxes/:id/usage` | mailbox member (message count and sizes) |
| GET | `/api/mailboxes/:id/export.mbox` | mailbox member (download everything) |
| POST | `/api/mailboxes/:id/threads/snooze` `{threadIds, until}` | mailbox member (`until` in ms, in the future) |
| POST | `/api/mailboxes/:id/threads/unsnooze` `{threadIds}` | mailbox member |
| GET | `/api/mailboxes/:id/contacts?q=pri&limit=8` | mailbox member (recipient suggestions) |
| GET/POST | `/api/mailboxes/:id/filters` `{query, actions, applyToExisting?}` | mailbox member |
| DELETE | `/api/mailboxes/:id/filters/:filterId` | mailbox member |
| POST | `/api/mailboxes/:id/drafts` `{to, cc, bcc, subject, html, parent?: {messageId, kind: "reply"\|"forward"}}` | mailbox member |
| GET/PUT/DELETE | `/api/mailboxes/:id/drafts/:draftId` | mailbox member (open, save, discard) |
| POST/DELETE | `/api/mailboxes/:id/drafts/:draftId/attachments[/:attachmentId]` | mailbox member (upload: raw body, `?filename=`) |
| POST | `/api/mailboxes/:id/drafts/:draftId/send` | mailbox member |
| POST | `/api/mailboxes/:id/drafts/:draftId/cancel-send` | mailbox member (undo send) |

`threads?label=` takes a label ID or `ALL` (All Mail). Threads in Trash or Spam are hidden from every other view and from the counts.

## Actions and undo

Every action is a label change, as in Gmail. Archive removes `INBOX`; Delete adds `TRASH`; Report spam adds `SPAM`; read and unread toggle `UNREAD`. Star and unread apply to the newest message only; everything else applies to every message in the thread. The server answers with exactly which labels changed on which messages, so **Undo** sends that change back reversed and restores the previous state precisely. `SENT`, `DRAFT` and `OUTBOX` are managed by the server and can't be changed by hand.

## How sending works

1. A draft is a message with the `DRAFT` label, saved as you type. A reply or forward joins the original's thread and records `In-Reply-To`/`References`; a forward also copies the original's attachments. The quoted text is kept out of the editor and appended as one block marked `gmail_quote`, so it folds away in Gmail and here.
2. **Send** moves the draft to `OUTBOX` and sets a Durable Object alarm for the end of the undo window (5–30 seconds, or off, in Settings). **Undo** moves it back to Drafts if it hasn't gone yet.
3. When the alarm fires, the mailbox hands the message to Cloudflare Email Service (`env.EMAIL.send`), from the mailbox's address and display name. On success it becomes `SENT` in the same thread, with the Message-ID Email Service returned, so replies to it thread correctly.
4. If Email Service refuses the message (unverified sender, suppressed recipient, too large…), it goes back to Drafts with the reason, and open tabs show it. Temporary failures (rate limits, delivery errors) are retried after 1, 5 and 15 minutes.

Limits follow Email Service: 50 recipients, 32 attachments and 25 MB per message.

## Search

Each mailbox keeps an SQLite FTS5 index (subject, sender, recipients, body text, attachment names) that triggers keep in step with every insert, edit and delete. Words match as prefixes, ignoring case and accents; `"quoted text"` matches an exact phrase. Results are conversations with at least one matching message, newest first. Spam and Trash are left out unless you ask for them.

| Operator | Example |
|---|---|
| words, `"phrase"`, `-word`, `OR` | `budget "launch plan" -draft`, `invoice OR receipt` |
| `from:` `to:` `cc:` `bcc:` `subject:` `filename:` | `from:alice@acme.com`, `subject:"Q4 plan"`, `filename:pdf` |
| `in:` | `inbox` `sent` `drafts` `starred` `important` `spam` `trash` `anywhere`, or a label name |
| `label:` | `label:receipts`, `label:"travel plans"` (or `travel-plans`) |
| `is:` | `unread` `read` `starred` `important` |
| `has:` | `attachment`, `userlabels`, `nouserlabels` |
| `after:` `before:` | `after:2026/10/01 before:2026-11-01` (your local dates) |
| `newer_than:` `older_than:` | `newer_than:7d`, `older_than:1y` (`d` `w` `m` `y`) |
| `larger:` `smaller:` | `larger:5M`, `smaller:100K` |

The search box has an options panel that builds these for you.

## Organising

- **Snooze** hides a conversation from the Inbox until a time you pick (presets or any date and time) and shows it under **Snoozed**. When the time comes, the mailbox's Durable Object alarm puts it back at the top of the Inbox, unread. A new message in the conversation, or moving it to the Inbox, Trash or Spam, ends the snooze early.
- **Filters** are searches (same syntax as the search box) run on each message as it arrives: skip the Inbox, mark as read, star, mark as important, apply a label or delete. **Create filter** in the search options panel starts one from your search, and a new filter can also be applied to the conversations already there.
- **Vacation responder** (Settings → Vacation) replies to incoming mail between optional first and last days, at most once per sender every 4 days, optionally only to people you've written to. It never answers mailing lists, bulk mail, bounces, no-reply senders or other auto-replies, and its replies carry `Auto-Submitted: auto-replied`. A banner shows while it's on, with **End now**.
- **Contacts** come from the people you send to and the people who write to you; the To/Cc/Bcc boxes suggest them, people you've written to first.
- **Trash and Spam** are emptied automatically: a message is deleted for good, with its files in R2, 30 days after it was moved there.

### Keyboard shortcuts

On by default (turn them off in the `?` dialog; the choice is saved in the browser). They're ignored while you're typing or a menu or dialog is open.

| Keys | Action |
|---|---|
| `c` | Compose |
| `/` | Search |
| `?` | Show shortcuts |
| `g` then `i` `s` `t` `d` `a` | Go to Inbox, Starred, Sent, Drafts, All Mail |
| `j` / `k` | Older / newer conversation (moves the cursor in a list, opens the next one in a conversation) |
| `o` or `Enter`, `u` | Open conversation, back to the list |
| `x` | Select conversation |
| `s`, `e`, `#`, `!`, `b` | Star, archive, delete, report spam, snooze |
| `Shift`+`i`, `Shift`+`u` | Mark as read, mark as unread |
| `r`, `a`, `f` | Reply, reply all, forward |

In a list, actions apply to the selected conversations, or to the one under the cursor.

## How receiving works

1. Email Routing calls the Worker's `email()` handler. Unknown recipients and messages over 25 MiB are rejected.
2. The Worker parses the message with `postal-mime` and puts the raw `.eml`, the attachments and any HTML body over 256 KB into R2 under `mailboxes/<id>/messages/<messageId>/`.
3. The mailbox Durable Object stores the message in one transaction. It skips duplicates (same Message-ID, since Email Routing may redeliver), finds the thread (by `In-Reply-To`/`References`, then by a reply arriving before its parent, then by a `Re:` subject within 30 days), labels it `INBOX` + `UNREAD`, runs your filters, and notifies connected browsers. The vacation responder answers afterwards, if it's on.
4. If storing fails, the R2 uploads are removed and the error is rethrown, so the delivery fails instead of the message being silently dropped.

To try it locally while `pnpm dev` runs, post a raw message to the local email endpoint:

```bash
curl -X POST "localhost:5173/cdn-cgi/handler/email?from=alice@sender.test&to=hello@example.com" \
  --data-binary $'From: alice@sender.test\r\nTo: hello@example.com\r\nSubject: Hi\r\n\r\nHello!\r\n'
```

## Reading mail safely

HTML mail is sanitised with DOMPurify, which strips scripts, event handlers, forms and embeds. It is then rendered in an iframe with no script permission. A Content Security Policy inside that iframe blocks remote images, CSS backgrounds and fonts until the user clicks **Display images**, so senders can't track opens. `cid:` images are served from the message's own attachments, and links open in a new tab without a referrer.

## License

Apache 2.0
