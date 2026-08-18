import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';

import { maskToken } from '#/cli/sub/notify';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const TELEGRAM_BOT_TOKEN_ENV = 'KIMI_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID_ENV = 'KIMI_TELEGRAM_CHAT_ID';

interface TelegramConfigSection {
  readonly bot_token?: string;
  readonly chat_id?: string;
  readonly enabled?: boolean;
}

export async function handleNotifyCommand(host: SlashCommandHost, args: string): Promise<void> {
  const subcommand = args.trim().toLowerCase();

  if (subcommand === 'setup') {
    host.showNotice(
      'Configure Telegram notifications',
      'Run "kimi notify setup" in your shell to pair a bot and save the config securely.',
    );
    return;
  }

  if (subcommand !== '' && subcommand !== 'status') {
    host.showError(`Unknown /notify subcommand: ${subcommand}`);
    return;
  }

  const config = await readTelegramConfig(host);
  const effectiveToken = config?.bot_token ?? process.env[TELEGRAM_BOT_TOKEN_ENV];
  const effectiveChatId = config?.chat_id ?? process.env[TELEGRAM_CHAT_ID_ENV];

  if (effectiveToken === undefined || effectiveToken.length === 0) {
    host.showNotice(
      'Telegram notifications are not configured',
      'Run "kimi notify setup" in your shell to configure them.',
    );
    return;
  }

  const lines = [`Token: ${maskToken(effectiveToken)}`];
  if (effectiveChatId !== undefined && effectiveChatId.length > 0) {
    lines.push(`Chat ID: ${effectiveChatId}`);
  } else {
    lines.push('Chat ID: (not set)');
  }
  lines.push(`Enabled: ${config?.enabled === false ? 'no' : 'yes'}`);

  host.showNotice('Telegram notifications', lines.join('\n'));
}

async function readTelegramConfig(
  host: SlashCommandHost,
): Promise<TelegramConfigSection | undefined> {
  const path = host.harness.configPath;
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    host.showError(`Failed to parse config.toml: ${formatErrorMessage(error)}`);
    return undefined;
  }

  const raw = parsed['telegram'];
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined;
  }

  return raw as TelegramConfigSection;
}
