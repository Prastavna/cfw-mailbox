# How it works

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

## How sending works

1. A draft is a message with the `DRAFT` label, saved as you type. A reply or forward joins the original's thread and records `In-Reply-To`/`References`; a forward also copies the original's attachments. The quoted text is kept out of the editor and appended as one block marked `gmail_quote`, so it folds away in Gmail and here.
2. **Send** moves the draft to `OUTBOX` and sets a Durable Object alarm for the end of the undo window (5–30 seconds, or off, in Settings). **Undo** moves it back to Drafts if it hasn't gone yet.
3. When the alarm fires, the mailbox hands the message to Cloudflare Email Service (`env.EMAIL.send`), from the mailbox's address and display name. On success it becomes `SENT` in the same thread, with the Message-ID Email Service returned, so replies to it thread correctly.
4. If Email Service refuses the message (unverified sender, suppressed recipient, too large…), it goes back to Drafts with the reason, and open tabs show it. Temporary failures (rate limits, delivery errors) are retried after 1, 5 and 15 minutes.

Limits follow Email Service: 50 recipients, 32 attachments and 25 MB per message.

## Reading mail safely

HTML mail is sanitised with DOMPurify, which strips scripts, event handlers, forms and embeds. It is then rendered in an iframe with no script permission. A Content Security Policy inside that iframe blocks remote images, CSS backgrounds and fonts until the user clicks **Display images**, so senders can't track opens. `cid:` images are served from the message's own attachments, and links open in a new tab without a referrer.

## Security

- **Sign-in:** every API request must carry a valid Cloudflare Access token for this application, checked by the Worker itself; mailbox access is then checked per mailbox, and unknown or forbidden mailboxes answer 404.
- **Cross-site requests:** state-changing requests must be JSON (which forces a CORS preflight) and come from the app's own origin; WebSocket upgrades must too.
- **Pages** are sent with a per-request nonce Content Security Policy (no inline scripts without the nonce, no framing, no plugins) and `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and, over HTTPS, HSTS. Static files get the same via `public/_headers`.
- **Mail content** is sanitised and shown in a sandboxed iframe with its own stricter policy (see [Reading mail safely](#reading-mail-safely)). Attachments and "Show original" are served with `nosniff` and a sandboxing CSP, and only images display inline.
