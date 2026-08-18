import { maskTelegramToken } from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from './dispatch';

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

  const config = await host.harness.getTelegramConfig();

  if (config.botToken === undefined || config.botToken.length === 0) {
    host.showNotice(
      'Telegram notifications are not configured',
      'Run "kimi notify setup" in your shell to configure them.',
    );
    return;
  }

  const lines = [
    `Token: ${maskTelegramToken(config.botToken)}`,
    `Chat ID: ${config.chatId ?? '(not set)'}`,
    `Enabled: ${config.enabled === false ? 'no' : 'yes'}`,
  ];

  host.showNotice('Telegram notifications', lines.join('\n'));
}
