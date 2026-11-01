# Mail client fixtures

Messages written to match how Gmail, Outlook and Apple Mail structure what they send
(MIME layout, encodings, headers), with made-up people and content. Addresses use
`.test` domains; `{{TO}}` is replaced with the test mailbox's address.

| File | What it exercises |
|---|---|
| `gmail-original.eml` | multipart/alternative inside multipart/related, quoted-printable UTF-8, an inline `cid:` image, `gmail_quote`-free original |
| `outlook-reply.eml` | `RE:` subject, `Thread-Index`, windows-1252 quoted-printable with smart quotes, Office HTML with conditional comments, a `winmail.dat` (TNEF) part |
| `apple-mail-reply.eml` | `Apple-Mail` boundaries, `format=flowed` text, RFC 2231 encoded filename, a `References` chain without `In-Reply-To` |
| `iso-2022-jp.eml` | a Japanese message in ISO-2022-JP with an encoded-word subject split across lines |
