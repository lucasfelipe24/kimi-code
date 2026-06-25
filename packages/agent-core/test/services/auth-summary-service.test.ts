import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import type { CoreRPC, KimiConfig } from '../../src';
import {
  AuthSummaryService,
  type ICoreProcessService,
  type IEnvironmentService,
} from '../../src/services';

function makeCore(config: KimiConfig): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    getKimiConfig: vi.fn(async () => config),
  };
  return {
    _serviceBrand: undefined,
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
  };
}

describe('AuthSummaryService', () => {
  it('accepts auth-code OAuth providers with a cached token', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-auth-summary-'));
    const env: IEnvironmentService = {
      _serviceBrand: undefined,
      homeDir,
      configPath: join(homeDir, 'config.toml'),
    };
    await new FileTokenStorage(join(homeDir, 'credentials')).save('openai-oauth', {
      accessToken: 'cached-token',
      refreshToken: 'refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: 'openid',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });

    const svc = new AuthSummaryService(env, makeCore({
      providers: {
        'openai-oauth': {
          type: 'openai_responses',
          baseUrl: 'https://example.test/v1',
        },
      },
      defaultModel: 'gpt-5.4',
      models: {
        'gpt-5.4': {
          provider: 'openai-oauth',
          model: 'gpt-5.4',
          maxContextSize: 272_000,
        },
      },
    }));

    await expect(svc.ensureReady('gpt-5.4')).resolves.toBeUndefined();
  });
});
