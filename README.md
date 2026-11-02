# cfw-mailbox

Self-hosted, Gmail-style webmail that runs entirely on your own Cloudflare account. Inspired by Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox).

- **Receive** with [Email Routing](https://developers.cloudflare.com/email-routing/), **send** with [Email Service](https://developers.cloudflare.com/email-service/).
- **Each mailbox** lives in its own SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/). Raw messages and attachments are stored in [R2](https://developers.cloudflare.com/r2/).
- **Many users, many domains.** Admins add domains and mailboxes and grant people access. Each user switches between the mailboxes they're allowed to open.
- **Sign-in** uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). The Worker verifies every request's Access token itself and enforces per-mailbox permissions.

**[Try the demo](https://prastavna.github.io/cfw-mailbox/)**: the real interface with made-up mail. It runs entirely in your browser, so nothing is sent and it resets when you reload.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Prastavna/cfw-mailbox)

## Features

- Threaded mail with archive, delete, spam, read/unread, stars and labels, all undoable
- Gmail-style compose: rich text, attachments, auto-saved drafts, signature, undo send
- Search with Gmail's operators, snooze, filters, vacation responder, contact suggestions, keyboard shortcuts
- Trash and Spam empty themselves after 30 days; download any mailbox as mbox
- Installable app with new-mail notifications, offline reading and swipe actions on phones
- Admin page at `/admin` for domains, mailboxes and members
- Optional **AI Assistant** (bring your own key): summarise, draft replies, rewrite, ask your inbox

## Quick start

```bash
pnpm install
pnpm dev
```

This signs you in as `dev@example.com` (an admin) on `localhost`. Open <http://localhost:5173/admin> to add a domain and a mailbox. Sending is simulated locally.

## Docs

- [Deploying](docs/deploying.md): setup, limits, backups
- [Development](docs/development.md): code layout, local dev, tests, the demo
- [Using the mailbox](docs/using.md): actions, search operators, snooze, filters, the installed app, shortcuts
- [How it works](docs/architecture.md): receiving, sending, safe rendering, security
- [AI Assistant](docs/ai-assistant.md): the extension and its providers
- [API](docs/api.md): HTTP endpoints

## Stack

React 19 + React Router (framework mode) · Tailwind v4 + shadcn/ui · TanStack Query · Hono + Zod · Durable Objects (SQLite) + Drizzle · R2 · Vitest in the Workers runtime.

## License

Apache 2.0
