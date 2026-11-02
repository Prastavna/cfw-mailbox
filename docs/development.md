# Development

## Layout

```
app/                 React UI
  routes/            / → last mailbox; /mail/:mailboxId/:folder[/:threadId]
  components/mail/   Header, account switcher, sidebar, thread list, conversation view
  components/extensions/  Extensions launcher (the 9-dot menu) and each extension's UI
    compose/         Compose windows, TipTap editor, recipient chips
  lib/email-html.ts  Sanitises HTML mail for a sandboxed iframe (DOMPurify + CSP)
  lib/compose*.ts    Reply recipients, quoting, signature; compose window store
  lib/shortcuts.ts   Keyboard shortcuts
  demo/              Static showcase only: fake data and an in-browser stand-in for the API
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
  extensions/ai/     AI Assistant: settings and encrypted keys, providers, prompts, routes
  push/              Web Push: VAPID and payload encryption (webpush.ts), new-mail notifications
  email/export.ts    mbox export (mbox.ts: mboxrd escaping; mime.ts: rebuilds sent mail)
  lib/security-headers.ts  Headers added to every response
  lib/crypto.ts      Encrypts users' secrets (AI keys) with ENCRYPTION_KEY
public/sw.js         Service worker: offline app and mail, notifications (app/lib/pwa.ts drives it)
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

The end-to-end tests keep their data in `.wrangler/e2e-state` and create a fresh mailbox per test, so they never touch your dev mail. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a Chromium you already have. The AI Assistant tests talk to a scripted, OpenAI-compatible fake provider that the test run starts on port 5181 (`e2e/fake-llm.ts`), so they need no key. The dev server they start has no remote bindings, so they don't need a Cloudflare login either (Workers AI isn't available there).

## Demo (GitHub Pages)

`pnpm build:demo` builds the interface as a static single-page app into `build/client/`. It has no Worker behind it: `app/demo/` answers every `/api` request in the browser from invented mail (`app/demo/seed.ts`), stands in for the live-update WebSocket, and gives canned, offline answers for the AI Assistant. It makes no network requests to any API. Sending, labels, snooze, filters, search and the admin page all work in memory and reset on reload. Sent mail gets a simulated reply, and a couple of messages "arrive" while the page is open, to show live updates.

`pnpm dev:demo` runs the same thing locally. The `Demo (GitHub Pages)` workflow publishes it on every push to `main`. It builds for `/<repo name>/`; set `DEMO_BASE` to build for another path. Under the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. Real builds (`pnpm build`) leave the demo code out.
