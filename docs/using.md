# Using the mailbox

## Actions and undo

Every action is a label change, as in Gmail. Archive removes `INBOX`; Delete adds `TRASH`; Report spam adds `SPAM`; read and unread toggle `UNREAD`. Star and unread apply to the newest message only; everything else applies to every message in the thread. The server answers with exactly which labels changed on which messages, so **Undo** sends that change back reversed and restores the previous state precisely. `SENT`, `DRAFT` and `OUTBOX` are managed by the server and can't be changed by hand.

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
