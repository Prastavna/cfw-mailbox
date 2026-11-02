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

## Notifications and offline mail

**Push.** Each install makes its own VAPID key pair the first time someone turns notifications on and keeps it in the registry Durable Object, so there's nothing to configure. A browser's subscription is stored with the mailboxes it wants to hear about. When a message is stored still unread in the Inbox (after filters), the Worker encrypts a small payload (sender, subject, a line of text) for each subscribed browser with the `aes128gcm` Web Push encoding and sends it to that browser's push service. Only that browser can read it. Whether the user may still open the mailbox is checked again before every notification. Subscriptions the push service reports as gone are deleted. The Worker only delivers to the major push services (Google, Mozilla, Apple, Microsoft), so a made-up endpoint can't make it call arbitrary URLs.

**Service worker** (`public/sw.js`). It keeps the app's code and pages so Mail opens without a connection, and shows notifications (a click opens the conversation). With **Offline mail** on, it also keeps the answers to the API reads that matter for reading (you, labels, settings, folder lists, conversations, inline images): fresh from the network when online, the saved copy when not, marked so the app can say it's showing saved mail. The app keeps the newest Inbox conversations saved in the background. Saved mail is tied to the signed-in user: a different account in the same browser wipes it first.

## Reading mail safely

HTML mail is sanitised with DOMPurify, which strips scripts, event handlers, forms and embeds. It is then rendered in an iframe with no script permission. A Content Security Policy inside that iframe blocks remote images, CSS backgrounds and fonts until the user clicks **Display images**, so senders can't track opens. `cid:` images are served from the message's own attachments, and links open in a new tab without a referrer.

## Security

- **Sign-in:** every API request must carry a valid Cloudflare Access token for this application, checked by the Worker itself; mailbox access is then checked per mailbox, and unknown or forbidden mailboxes answer 404.
- **Cross-site requests:** state-changing requests must be JSON (which forces a CORS preflight) and come from the app's own origin; WebSocket upgrades must too.
- **Pages** are sent with a per-request nonce Content Security Policy (no inline scripts without the nonce, no framing, no plugins) and `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and, over HTTPS, HSTS. Static files get the same via `public/_headers`.
- **Notifications** are end-to-end encrypted for the subscribed browser (RFC 8291) and signed with this install's VAPID key (RFC 8292). They're only sent to people who can still open the mailbox, and only to known push services.
- **Mail content** is sanitised and shown in a sandboxed iframe with its own stricter policy (see [Reading mail safely](#reading-mail-safely)). Attachments and "Show original" are served with `nosniff` and a sandboxing CSP, and only images display inline.
