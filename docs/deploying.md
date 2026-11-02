# Deploying

## With the button

1. Click **Deploy to Cloudflare** in the [README](../README.md). It forks the repository into your GitHub or GitLab account, creates the R2 bucket and Durable Objects, and deploys the Worker. It asks for `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` and `ENCRYPTION_KEY`; you can leave the Access values empty for now and set them in step 2.
2. Continue from step 2 of *By hand* below.

## By hand

1. `npx wrangler r2 bucket create cfw-mailbox`, then `pnpm run deploy`.
2. **Protect it with Access.** Enable [one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on the Worker, then set the secrets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (`npx wrangler secret put ACCESS_AUD`, or in the dashboard) from the values it shows. Until both are set, the API refuses every request.
3. Set the secret `ADMIN_EMAILS` to the people who manage domains and mailboxes (comma-separated), and `ENCRYPTION_KEY` to a long random string (`openssl rand -base64 32`). It encrypts the AI provider keys people save; without it the AI Assistant only offers Workers AI. Changing it later makes saved keys unreadable, and people are asked to enter them again.
4. For each domain, enable **Email Routing** and add a catch-all rule that sends to this Worker. Mail to addresses that have no mailbox is rejected.
5. Enable **Email Service** sending for each domain (`npx wrangler email sending enable example.com`). Until a domain is onboarded, sending from it fails with a message saying so, and the draft stays in Drafts.

`.dev.vars.example` lists the secrets. Workers Builds and the Deploy button keep redeploying from your repository's default branch.


## Limits

| What | Limit |
|---|---|
| Incoming message | 25 MiB (Email Routing's cap); larger mail is rejected |
| Outgoing message | 50 recipients, 32 attachments, 25 MB (Email Service) |
| API requests | 600 a minute per user |
| Sends, uploads, exports | 30 a minute per user |
| AI Assistant requests | 20 a minute per user |
| JSON request body | 1 MiB (a draft's HTML is capped at 300 KB) |
| Mailbox database | about 9 GiB of the Durable Object's 10 GB; past that, new mail is bounced with "Mailbox is full" |

Request budgets use the [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): they're counted per Cloudflare location and approximate, a guard against runaway scripts rather than a quota. Change them under `ratelimits` in `wrangler.jsonc`. Attachments and raw messages live in R2 and don't count towards the database size; Settings → General shows both.

## Backups and export

- **Download all mail** (Settings → General) streams the whole mailbox as an [mboxrd](https://en.wikipedia.org/wiki/Mbox) file that Thunderbird, Apple Mail and most migration tools import. Received mail is exported byte for byte; mail sent from here is rebuilt from what's stored (Email Service doesn't hand back the raw message). Each message carries an `X-Mailbox-Labels` header. Unsent drafts are left out.
- **R2** keeps the original `.eml` of every received message under `mailboxes/<id>/messages/`. Turn on [bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) if you want deletions to be impossible for a retention period.
- **Durable Objects** (the mailbox databases) are stored by Cloudflare with [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/storage-api/#pitr-point-in-time-recovery-api) for the last 30 days. The app doesn't expose restores; for now, keep regular mbox exports.
