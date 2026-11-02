# AI Assistant

Extensions live in the 9-dot menu at the top right. Each user turns them on for themselves; until they do, nothing about them appears in the app and their API refuses requests. The first one is the **AI Assistant**:

- **Summarise** a conversation (button next to its subject).
- **Help me write** in the composer: describe the email or reply and get a draft; or select text and shorten it, make it more formal or friendly, fix its grammar, or describe your own change. The result is shown first and goes into the message only when you click Insert or Replace.
- **Ask your inbox** (sparkle button in the top bar): a chat that searches and reads the open mailbox to answer questions, and links to the conversations it used. Its tools are read-only: it can't send, delete or change mail.

Nothing runs automatically: every request starts with a click, and only the conversation or text it needs is sent to the provider.

**Bring your own key.** In the AI Assistant's settings each user picks a provider and model:

| Provider | Key |
|---|---|
| Anthropic, OpenAI, Google Gemini | The user's own API key |
| OpenAI-compatible | A server URL (OpenRouter, Groq, Together, Mistral, DeepSeek, a local Ollama or LM Studio…) and its key, if it needs one |
| Workers AI | None: runs on the Cloudflare account the mail server is deployed on, which pays for it |

Keys are encrypted with AES-256-GCM under `ENCRYPTION_KEY` before they're stored, bound to their owner, and never sent back to the browser. The model list comes from the provider using the saved key. Providers are reached through the [AI SDK](https://ai-sdk.dev/); Workers AI through the `AI` binding.

Mail is written by strangers and can contain text aimed at the model ("ignore your instructions…"). Prompts mark mail as untrusted content, and because the assistant can only read, the most such a message can do is mislead its answer, which is why AI output is labelled and links back to the source.
