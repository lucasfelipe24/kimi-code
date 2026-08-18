import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { parseBooleanEnv } from '#/_base/utils/env';

export const TELEGRAM_SECTION = 'telegram';

export const TelegramConfigSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  enabled: z.boolean().optional(),
  threaded: z.boolean().optional(),
  streaming: z.boolean().optional(),
  redact: z.boolean().optional(),
  btw: z.object({ enabled: z.boolean().optional() }).optional(),
  toolActivity: z.object({ enabled: z.boolean().optional() }).optional(),
  rich: z.object({ enabled: z.boolean().optional() }).optional(),
  verbosity: z.enum(['lean', 'verbose']).optional(),
});

export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export const TELEGRAM_BOT_TOKEN_ENV = 'KIMI_TELEGRAM_BOT_TOKEN';
export const TELEGRAM_CHAT_ID_ENV = 'KIMI_TELEGRAM_CHAT_ID';
export const TELEGRAM_ENABLED_ENV = 'KIMI_TELEGRAM_ENABLED';

function parseNonBlankEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const telegramEnvBindings: EnvBindings<TelegramConfig> = envBindings(
  TelegramConfigSchema,
  {
    botToken: { env: TELEGRAM_BOT_TOKEN_ENV, parse: parseNonBlankEnv },
    chatId: { env: TELEGRAM_CHAT_ID_ENV, parse: parseNonBlankEnv },
    enabled: { env: TELEGRAM_ENABLED_ENV, parse: parseBooleanEnv },
  },
);

export const stripTelegramEnv = stripEnvBoundFields(telegramEnvBindings);

registerConfigSection(TELEGRAM_SECTION, TelegramConfigSchema, {
  defaultValue: {},
  env: telegramEnvBindings,
  stripEnv: stripTelegramEnv,
});
