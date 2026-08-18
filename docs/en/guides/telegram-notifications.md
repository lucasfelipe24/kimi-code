# Telegram notifications

Kimi Code CLI can send session updates to a private Telegram chat and accept short replies and commands from it. Use this to keep an eye on long-running tasks from your phone, answer an `AskUserQuestion` prompt with inline buttons, or send a quick `/btw` side question without reopening the terminal.

In the current version the integration supports only a flat private chat: one bot, one chat, and no forum topics or rich Markdown. Notifications, reply-driven turns, button answers, `/btw`, and the `telegram_send` tool all work in this mode.

## Before you start

You need a Telegram bot token. Create one by talking to [@BotFather](https://t.me/botfather) in Telegram:

1. Send `/newbot` and follow the prompts to choose a name and username.
2. BotFather returns a token that looks like `123456789:ABCdefGHIjklMNOpqrSTUvwxyz`.
3. Copy the token and keep it private — treat it like an API key.

## Pair your chat

The easiest way to configure the integration is with the CLI setup command:

```sh
kimi notify setup
```

When asked, paste the bot token from BotFather. The command starts a short one-time poll, then sends a test message to the first private chat that messages the bot. Reply to that message and the CLI stores the chat pairing in your global config.

If you already know the chat ID, you can pass it directly:

```sh
kimi notify setup --chat-id YOUR_CHAT_ID
```

To check whether the integration is configured and whether the bot can still reach Telegram, run:

```sh
kimi notify status
```

The status output masks the token so it is never printed.

## Configure in `config.toml`

Telegram settings live in the `[telegram]` table of `~/.kimi-code/config.toml`. They are global-only: a project cannot override them, which means a hostile workspace cannot silently enable notifications or steal your bot token.

```toml
[telegram]
bot_token = "YOUR_BOT_TOKEN"
chat_id = "YOUR_CHAT_ID"
enabled = true
redact = false

[telegram.btw]
enabled = true

[telegram.tool_activity]
enabled = false
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `bot_token` | `string` | — | Bot token from BotFather |
| `chat_id` | `string` | — | Telegram chat ID that receives messages |
| `enabled` | `boolean` | `false` | Master switch for the integration |
| `redact` | `boolean` | `false` | When `true`, scrub credential-shaped and diagnostic content from outbound messages |
| `btw.enabled` | `boolean` | `true` | Allow the `/btw` side-question command in Telegram |
| `tool_activity.enabled` | `boolean` | `false` | Send live tool-call start/result notices in addition to final answers |

You can also set the two required values through environment variables, which take priority over the config file and are never written back to disk:

```sh
export KIMI_TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN"
export KIMI_TELEGRAM_CHAT_ID="YOUR_CHAT_ID"
export KIMI_TELEGRAM_ENABLED=1
```

## TUI slash command

Inside the interactive TUI, type `/notify` to open the Telegram notification panel. From there you can view the current pairing, re-run setup, or toggle whether notifications are sent without editing the config file by hand.

## Using Telegram with Kimi Code

Once paired and enabled, the bot starts sending messages to the configured private chat:

- **Final answers** are delivered when a turn completes.
- **Ask prompts** from `AskUserQuestion` arrive with inline buttons; tap a button to answer, or send a free-text reply.
- **Free-text replies** in the chat are injected into the current session as a new prompt, so you can continue the conversation from Telegram.
- **`/btw <question>`** starts a short side conversation in a forked subagent. The answer is sent back to Telegram and does not affect the main session transcript.
- **`telegram_send`** is an agent tool that pushes a workspace file to the chat, with an optional caption.

::: tip Note
The integration only works while a Kimi Code process hosting the active session is running. It is not a persistent remote daemon.
:::

## Security notes

- Telegram config is stored only in the user-level `config.toml`, never in a project-local file.
- `kimi notify status` and the `/notify` panel display a masked token, not the real value.
- The bot only sends messages to the single configured private chat. Group chats and forum topics are not supported in this version.

## Next steps

- [Built-in Tools](../reference/tools.md) — Full list of tools the agent can call, including `telegram_send`
- [Environment Variables](../configuration/env-vars.md) — All runtime variables that affect Kimi Code CLI
