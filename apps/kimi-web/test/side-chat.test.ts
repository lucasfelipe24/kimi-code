// apps/kimi-web/test/side-chat.test.ts
//
// Side chat ("BTW"): openSideChat creates a CHILD session via the /children
// endpoint, sends the question to that child, echoes it into the side-chat
// transcript, and keeps the child out of the main session list.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string, extra: Partial<AppSession> = {}): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...extra,
  };
}

async function setup() {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  let promptN = 0;
  const created = session('sess_1');
  const child = session('child_1', { parentSessionId: 'sess_1', title: 'Side chat' });
  const api = {
    createSession: vi.fn(async () => created),
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    submitPrompt: vi.fn(async () => {
      promptN += 1;
      return { promptId: `pr_${promptN}`, userMessageId: `msg_real_${promptN}`, status: 'running' };
    }),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
    createChildSession: vi.fn(async () => child),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    child,
    client: useKimiWebClient(),
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('side chat (BTW)', () => {
  it('opens a child session, sends the question, and echoes it', async () => {
    const { api, client } = await setup();
    await client.createSession('/repo');

    await client.openSideChat('what does this do?');

    // A child session is created under the active session.
    expect(api.createChildSession).toHaveBeenCalledWith('sess_1', { title: 'Side chat' });
    // The question goes to the CHILD, as a plain text prompt.
    const call = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('child_1');
    expect((call[1] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'what does this do?' },
    ]);

    // The side-chat panel is open and shows the question.
    expect(client.sideChatVisible.value).toBe(true);
    const userTurns = client.sideChatTurns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['what does this do?']);
  });

  it('keeps the child session out of the main session list', async () => {
    const { client, getHandlers } = await setup();
    await client.createSession('/repo');
    await client.openSideChat();

    // The daemon broadcasts the child's creation like any session.
    getHandlers().onEvent(
      { type: 'sessionCreated', session: session('child_1', { parentSessionId: 'sess_1' }) },
      { sessionId: 'child_1', seq: 1 },
    );

    const ids = client.sessionsForView.value.map((s) => s.id);
    expect(ids).toContain('sess_1');
    expect(ids).not.toContain('child_1');
  });
});
