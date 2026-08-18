/**
 * Telegram config + pairing surface for the v2 SDK.
 *
 * The shapes are owned by the engine (`@moonshot-ai/agent-core-v2/features/telegram`).
 * This module re-exports them so SDK consumers do not import agent-core-v2 directly,
 * and adds the small SDK-specific input seam (`fetchImpl`) used to mock the Bot API
 * in tests.
 */
import type { TelegramConfig } from '@moonshot-ai/agent-core-v2';
import type {
  RunTelegramSetupInput,
  TelegramSetupFailure,
  TelegramSetupResult,
  TelegramSetupStatus,
  TelegramSetupSuccess,
} from '@moonshot-ai/agent-core-v2/features/telegram/setup';

export type { TelegramConfig };
export type {
  TelegramSetupFailure,
  TelegramSetupResult,
  TelegramSetupStatus,
  TelegramSetupSuccess,
};
export {
  maskToken as maskTelegramToken,
  tokenFingerprint as telegramTokenFingerprint,
} from '@moonshot-ai/agent-core-v2/features/telegram/redact';
export { TELEGRAM_SECTION } from '@moonshot-ai/agent-core-v2';

/**
 * SDK input for `runTelegramSetup`. Mirrors the engine pairing input and adds
 * an optional `fetchImpl` so callers can stub the Bot API (tests) or route
 * traffic through a custom fetch (proxy, telemetry, etc.).
 */
export interface RunTelegramSetupSdkInput extends RunTelegramSetupInput {
  readonly fetchImpl?: typeof fetch;
}
