# API

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
| GET | `/api/extensions` | signed in (extensions and whether each is on) |
| GET/PUT | `/api/extensions/ai` `{enabled, provider, model, baseUrl, apiKey}` | signed in (own settings; the key is write-only) |
| GET | `/api/extensions/ai/models` | signed in (models from the provider) |
| POST | `/api/extensions/ai/test` | signed in (a tiny request to check the key and model) |
| POST | `/api/extensions/ai/rewrite` `{text, mode?, instructions?}` | signed in, AI on (streams plain text) |
| POST | `/api/mailboxes/:id/ai/summarize` `{threadId}` | mailbox member, AI on (streams plain text) |
| POST | `/api/mailboxes/:id/ai/write` `{instructions, parentMessageId?, subject?, to?, current?}` | mailbox member, AI on (streams plain text) |
| POST | `/api/mailboxes/:id/ai/chat` `{messages, tz}` | mailbox member, AI on (AI SDK UI message stream) |

`threads?label=` takes a label ID or `ALL` (All Mail). Threads in Trash or Spam are hidden from every other view and from the counts.
