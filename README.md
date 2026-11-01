# cfw-mailbox

Self-hosted, Gmail-style webmail that runs entirely on your own Cloudflare account. Inspired by Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox).

- **Receive** with [Email Routing](https://developers.cloudflare.com/email-routing/), **send** with [Email Service](https://developers.cloudflare.com/email-service/).
- **Each mailbox** lives in its own SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/). Raw messages and attachments are stored in [R2](https://developers.cloudflare.com/r2/).
- **Many users, many domains.** Admins add domains and mailboxes and grant people access. Each user switches between the mailboxes they're allowed to open.
- **Sign-in** uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). The Worker verifies every request's Access token itself and enforces per-mailbox permissions.

> Status: **Phase 1 (receiving)**. Sign-in, the mailbox directory and the admin API work, and mail is received, threaded and readable over the API, with live updates. The Gmail-style UI (Phase 2) and sending come next.

## Stack

React 19 + React Router (framework mode) · Tailwind v4 + shadcn/ui · TanStack Query · Hono + Zod · Durable Objects (SQLite) + Drizzle · R2 · Vitest in the Workers runtime.

## Layout

```
app/                 React UI (routes, components, shadcn/ui)
shared/              Types and helpers used by both browser and Worker
workers/
  app.ts             Worker entry: /api → Hono, everything else → React Router
  api/               HTTP API
  auth/access.ts     Cloudflare Access JWT verification (+ local dev mode)
  registry/          RegistryDO: domains, mailboxes, members (one global instance)
  mailbox/           MailboxDO: one per mailbox; threads, messages, labels
  email/inbound.ts   Email Routing handler
test/                Vitest tests that run in workerd
```

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # set DEV_USER_EMAIL / ADMIN_EMAILS to your address
pnpm dev
```

`AUTH_MODE=dev` signs you in as `DEV_USER_EMAIL`, and only on `localhost`. Create a domain and a mailbox through the admin API:

```bash
curl -X POST localhost:5173/api/admin/domains   -H 'content-type: application/json' -d '{"domain":"example.com"}'
curl -X POST localhost:5173/api/admin/mailboxes -H 'content-type: application/json' \
  -d '{"address":"hello@example.com","displayName":"Hello"}'
```

Checks: `pnpm test`, `pnpm run typecheck`, `pnpm run build`.

## Deploying (self-hosting)

1. `wrangler r2 bucket create cfw-mailbox`, then `pnpm run deploy`.
2. **Protect it with Access.** Enable [one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on the Worker, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` from the values it shows. Without them, the API refuses every request.
3. Set `ADMIN_EMAILS` to the people who manage domains and mailboxes.
4. For each domain, enable **Email Routing** and add a catch-all rule that sends to this Worker. Mail to addresses that have no mailbox is rejected.
5. Enable **Email Service** sending for each domain.

## API (so far)

| Method | Path | Who |
|---|---|---|
| GET | `/api/health` | anyone |
| GET | `/api/me` | signed in |
| GET/POST/DELETE | `/api/admin/domains[/:domain]` | admin |
| GET/POST/DELETE | `/api/admin/mailboxes[/:id]` | admin |
| GET/PUT/DELETE | `/api/admin/mailboxes/:id/members[/:email]` | admin |
| GET | `/api/mailboxes/:id/labels` | mailbox member (with total/unread counts) |
| GET | `/api/mailboxes/:id/threads?label=INBOX&cursor=&limit=` | mailbox member |
| GET | `/api/mailboxes/:id/threads/:threadId` | mailbox member |
| GET | `/api/mailboxes/:id/messages/:messageId/attachments/:attachmentId[?inline=1]` | mailbox member |
| GET | `/api/mailboxes/:id/messages/:messageId/raw` | mailbox member ("Show original") |
| GET (WebSocket) | `/api/mailboxes/:id/events` | mailbox member: pushes `threads.changed` |

## How receiving works

1. Email Routing calls the Worker's `email()` handler. Unknown recipients and messages over 25 MiB are rejected.
2. The Worker parses the message with `postal-mime` and puts the raw `.eml`, the attachments and any HTML body over 256 KB into R2 under `mailboxes/<id>/messages/<messageId>/`.
3. The mailbox Durable Object stores the message in one transaction. It skips duplicates (same Message-ID, since Email Routing may redeliver), finds the thread (by `In-Reply-To`/`References`, then by a reply arriving before its parent, then by a `Re:` subject within 30 days), labels it `INBOX` + `UNREAD`, and notifies connected browsers.
4. If storing fails, the R2 uploads are removed and the error is rethrown, so the delivery fails instead of the message being silently dropped.

To try it locally while `pnpm dev` runs, post a raw message to the local email endpoint:

```bash
curl -X POST "localhost:5173/cdn-cgi/handler/email?from=alice@sender.test&to=hello@example.com" \
  --data-binary $'From: alice@sender.test\r\nTo: hello@example.com\r\nSubject: Hi\r\n\r\nHello!\r\n'
```

## License

Apache 2.0
