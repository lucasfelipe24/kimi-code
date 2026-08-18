import { access, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { TelegramGatewayService, ITelegramGatewayService } from '#/features/telegram/gateway';

function noOpEvent() {
  return { dispose: () => {} };
}

function stubConfig(getValue: (domain: string) => unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: noOpEvent,
    onDidSectionChange: noOpEvent,
    onDidChangeDiagnostics: noOpEvent,
    get: vi.fn(getValue) as unknown as <T>(domain: string) => T,
    inspect: vi.fn(() => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined })),
    getAll: vi.fn(() => ({})),
    set: vi.fn(() => Promise.resolve()),
    replace: vi.fn(() => Promise.resolve()),
    replaceSections: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    diagnostics: vi.fn(() => []),
  } as unknown as IConfigService;
}

describe('TelegramGatewayService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    homeDir = join(tmpdir(), `kimi-telegram-gateway-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reports unconfigured when no token is set', () => {
    ix.stub(IConfigService, stubConfig(() => ({})));
    ix.stub(IBootstrapService, { _serviceBrand: undefined, homeDir } as unknown as IBootstrapService);
    ix.set(ITelegramGatewayService, new SyncDescriptor(TelegramGatewayService));
    const gateway = ix.get(ITelegramGatewayService);

    expect(gateway.gatewayState.configured).toBe(false);
    expect(gateway.gatewayState.maskedToken).toBe('(unset)');
    expect(gateway.gatewayState.chatId).toBeUndefined();
  });

  it('reports configured after config provides token, chat and enabled', async () => {
    ix.stub(IConfigService, stubConfig((domain: string) =>
      domain === 'telegram' ? { botToken: '123456:ABC-DEF', chatId: '42', enabled: true } : undefined,
    ));
    ix.stub(IBootstrapService, { _serviceBrand: undefined, homeDir } as unknown as IBootstrapService);
    ix.set(ITelegramGatewayService, new SyncDescriptor(TelegramGatewayService));
    const gateway = ix.get(ITelegramGatewayService);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.gatewayState.configured).toBe(true);
    expect(gateway.gatewayState.maskedToken).toContain('…');
    expect(gateway.gatewayState.chatId).toBe('42');
  });

  it('returns 0 for send when not configured', async () => {
    ix.stub(IConfigService, stubConfig(() => ({})));
    ix.stub(IBootstrapService, { _serviceBrand: undefined, homeDir } as unknown as IBootstrapService);
    ix.set(ITelegramGatewayService, new SyncDescriptor(TelegramGatewayService));
    const gateway = ix.get(ITelegramGatewayService);
    const id = await gateway.sendMessage({ text: 'hello' });

    expect(id).toBe(0);
  });

  it('acquires the poller lock while running', async () => {
    ix.stub(IConfigService, stubConfig((domain: string) =>
      domain === 'telegram' ? { botToken: '123456:ABC-DEF', chatId: '42', enabled: true } : undefined,
    ));
    ix.stub(IBootstrapService, { _serviceBrand: undefined, homeDir } as unknown as IBootstrapService);
    ix.set(ITelegramGatewayService, new SyncDescriptor(TelegramGatewayService));
    ix.get(ITelegramGatewayService);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const lockPath = join(homeDir, 'telegram', 'poller.lock');
    await expect(access(lockPath)).resolves.toBeUndefined();
  });
});
