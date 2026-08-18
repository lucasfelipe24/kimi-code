# Telegram 通知

Kimi Code CLI 可以把会话更新推送到一个私有的 Telegram 聊天，并在聊天中接收简短回复和命令。这样你可以在手机上关注长时间运行的任务、用内联按钮回答 `AskUserQuestion` 提示，或者无需重新打开终端就能发送一条 `/btw` 旁路问题。

当前版本的集成仅支持扁平的私聊模式：一个 bot、一个聊天，不支持论坛主题（forum topic）和富文本 Markdown。通知、回复驱动的轮次、按钮回答、`/btw` 以及 `telegram_send` 工具都在此模式下可用。

## 开始之前

你需要一个 Telegram bot token。在 Telegram 中与 [@BotFather](https://t.me/botfather) 对话来创建：

1. 发送 `/newbot`，按提示选择 bot 名称和用户名。
2. BotFather 会返回一个形如 `123456789:ABCdefGHIjklMNOpqrSTUvwxyz` 的 token。
3. 复制该 token 并妥善保管——它的敏感程度与 API 密钥相同。

## 配对聊天

最简单的配置方式是使用 CLI 的 setup 命令：

```sh
kimi notify setup
```

按提示粘贴 BotFather 给出的 bot token。命令会进行一次短暂的轮询，然后向第一个给 bot 发消息的私聊发送测试消息。回复该消息后，CLI 就会把配对信息写入你的全局配置。

如果你已经知道 chat ID，也可以直接传入：

```sh
kimi notify setup --chat-id YOUR_CHAT_ID
```

要检查集成是否已配置、以及 bot 是否仍能访问 Telegram，可运行：

```sh
kimi notify status
```

状态输出会对 token 做脱敏处理，不会打印真实值。

## 在 `config.toml` 中配置

Telegram 设置位于 `~/.kimi-code/config.toml` 的 `[telegram]` 表中。这些配置仅全局生效：项目无法覆盖它们，因此恶意工作空间无法悄悄启用通知或窃取 bot token。

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

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `bot_token` | `string` | — | 从 BotFather 获取的 bot token |
| `chat_id` | `string` | — | 接收消息的 Telegram chat ID |
| `enabled` | `boolean` | `false` | 集成的总开关 |
| `redact` | `boolean` | `false` | 设为 `true` 时， outbound 消息会清除形似凭据和诊断日志的内容 |
| `btw.enabled` | `boolean` | `true` | 允许在 Telegram 中使用 `/btw` 旁路问题命令 |
| `tool_activity.enabled` | `boolean` | `false` | 除最终答案外，同时发送工具调用的开始/结果通知 |

你也可以通过环境变量设置两个必填项。环境变量优先于配置文件，且不会被写回磁盘：

```sh
export KIMI_TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN"
export KIMI_TELEGRAM_CHAT_ID="YOUR_CHAT_ID"
export KIMI_TELEGRAM_ENABLED=1
```

## TUI 斜杠命令

在交互式 TUI 中输入 `/notify` 可打开 Telegram 通知面板。你可以在面板中查看当前配对、重新运行 setup，或直接开关通知，无需手动编辑配置文件。

## 在 Telegram 中使用 Kimi Code

完成配对并启用后，bot 就会开始向配置的私聊发送消息：

- **最终答案**：某个轮次完成时送达。
- **`AskUserQuestion` 提示**：会附带内联按钮；点击按钮即可回答，也可以发送文字回复。
- **文字回复**：聊天中的任意文字回复都会作为新的 prompt 注入当前会话，因此你可以直接在 Telegram 里继续对话。
- **`/btw <问题>`**：在 fork 出的 subagent 中开启一段简短的旁路对话。回答会返回 Telegram，且不会影响 main session 的 transcript。
- **`telegram_send`**：agent 可调用的工具，用于把工作区文件推送到聊天，并可附带一段说明文字。

::: tip 提示
该集成只在承载当前会话的 Kimi Code 进程运行时有效。它不是一个常驻的远程 daemon。
:::

## 安全说明

- Telegram 配置只保存在用户级的 `config.toml` 中，不会进入项目级本地配置。
- `kimi notify status` 和 `/notify` 面板只会显示脱敏后的 token，不会展示真实值。
- bot 只会向单个配置的私聊发送消息。当前版本不支持群组聊天和论坛主题。

## 下一步

- [内置工具](../reference/tools.md) —— Agent 可调用的工具完整列表，包括 `telegram_send`
- [环境变量](../configuration/env-vars.md) —— 影响 Kimi Code CLI 的所有运行时变量
