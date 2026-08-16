import type { MemorySummary } from '@moonshot-ai/kimi-code-sdk';

import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import { MemorySelectorComponent } from '#/tui/components/dialogs/memory-selector';

import {
  memoryToDoc,
  newMemoryTemplate,
  parseMemoryDoc,
  toCreateInput,
} from './memory-doc';
import type { SlashCommandHost } from './dispatch';

const NO_EDITOR_NOTICE = 'No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.';

/**
 * `/memory` — native persistent-memory manager. Opens a searchable list of the
 * workspace's durable memories: create (`N`) and edit (`E`) open the memory as a
 * markdown document (frontmatter + body) in `$EDITOR`, `Enter` views the full
 * body, and `D` forgets. The agent manages the same store through its Memory tool.
 */
export function handleMemoryCommand(host: SlashCommandHost, args: string): void {
  void args;
  void openMemoryManager(host);
}

async function openMemoryManager(host: SlashCommandHost): Promise<void> {
  const workDir = host.state.appState.workDir;
  let memories: readonly MemorySummary[];
  try {
    memories = await host.harness.listMemories(workDir);
  } catch (error) {
    host.showError(`Failed to load memories: ${formatMemoryError(error)}`);
    return;
  }

  mountMemoryManager(host, memories);
}

function mountMemoryManager(host: SlashCommandHost, memories: readonly MemorySummary[]): void {
  host.mountEditorReplacement(
    new MemorySelectorComponent({
      memories,
      onCreate: () => {
        void createMemoryFlow(host);
      },
      onEdit: (memory) => {
        void editMemoryFlow(host, memory);
      },
      onView: (memory) => {
        viewMemory(host, memory);
      },
      onForget: (memory) => {
        void forgetMemory(host, memory);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/** Re-list and remount the manager, or drop back to the editor when empty. */
async function refreshMemoryManager(host: SlashCommandHost): Promise<void> {
  const workDir = host.state.appState.workDir;
  let memories: readonly MemorySummary[];
  try {
    memories = await host.harness.listMemories(workDir);
  } catch {
    host.restoreEditor();
    return;
  }
  mountMemoryManager(host, memories);
}

async function createMemoryFlow(host: SlashCommandHost): Promise<void> {
  const edited = await runExternalEditor(host, newMemoryTemplate());
  if (edited === undefined) {
    // Cancelled / no editor — the manager was already restored by the runner.
    return;
  }
  const parsed = parseMemoryDoc(edited);
  if (!parsed.ok) {
    host.showError(`Memory not saved: ${parsed.error}`);
    void refreshMemoryManager(host);
    return;
  }
  const workDir = host.state.appState.workDir;
  try {
    await host.harness.createMemory(workDir, toCreateInput(parsed.value));
  } catch (error) {
    host.showError(`Failed to create memory: ${formatMemoryError(error)}`);
    void refreshMemoryManager(host);
    return;
  }
  host.track('memory_write', { scope: parsed.value.scope });
  host.showStatus('Memory created.', 'success');
  void refreshMemoryManager(host);
}

async function editMemoryFlow(host: SlashCommandHost, memory: MemorySummary): Promise<void> {
  const edited = await runExternalEditor(host, memoryToDoc(memory));
  if (edited === undefined) {
    return;
  }
  const parsed = parseMemoryDoc(edited);
  if (!parsed.ok) {
    host.showError(`Memory not saved: ${parsed.error}`);
    void refreshMemoryManager(host);
    return;
  }
  const workDir = host.state.appState.workDir;
  const { scope, type, name, description, body } = parsed.value;
  try {
    await host.harness.updateMemory(workDir, memory.id, { scope, type, name, description, body });
  } catch (error) {
    host.showError(`Failed to update memory: ${formatMemoryError(error)}`);
    void refreshMemoryManager(host);
    return;
  }
  host.track('memory_write', { scope });
  host.showStatus('Memory updated.', 'success');
  void refreshMemoryManager(host);
}

function viewMemory(host: SlashCommandHost, memory: MemorySummary): void {
  host.showNotice(memory.name, memoryToDoc(memory));
}

async function forgetMemory(host: SlashCommandHost, memory: MemorySummary): Promise<void> {
  const workDir = host.state.appState.workDir;
  try {
    await host.harness.forgetMemory(workDir, memory.scope, memory.id);
  } catch (error) {
    host.showError(`Failed to forget memory: ${formatMemoryError(error)}`);
    return;
  }
  host.track('memory_forget', { scope: memory.scope });
  host.showStatus('Memory forgotten.', 'success');
  void refreshMemoryManager(host);
}

/**
 * Suspend the TUI, run `$EDITOR` on the seed document, then resume — mirrors
 * `EditorKeyboardController.openExternalEditor`. Returns the edited text, or
 * `undefined` when there is no editor or the editor exited without saving. On
 * every path the memory manager is remounted so the user is never stranded.
 */
async function runExternalEditor(
  host: SlashCommandHost,
  seed: string,
): Promise<string | undefined> {
  const { state } = host;
  if (state.externalEditorRunning) return undefined;
  const cmd = resolveEditorCommand(state.appState.editorCommand);
  if (cmd === undefined) {
    host.showError(NO_EDITOR_NOTICE);
    void refreshMemoryManager(host);
    return undefined;
  }

  state.externalEditorRunning = true;
  state.ui.stop();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  let result: string | undefined;
  try {
    const edited = await editInExternalEditor(seed, cmd);
    if (edited !== undefined) {
      result = edited.replaceAll('\r\n', '\n').replace(/\n$/, '');
    }
  } catch (error) {
    host.showError(`External editor failed: ${formatMemoryError(error)}`);
  } finally {
    if (typeof process.stdin.pause === 'function') {
      process.stdin.pause();
    }
    state.ui.start();
    state.ui.requestRender(true);
    state.externalEditorRunning = false;
  }

  if (result === undefined) {
    // Editor cancelled — restore the manager view.
    void refreshMemoryManager(host);
  }
  return result;
}

function memoryErrorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * Human-readable message for a memory error, favouring the actionable guidance
 * the engine attaches to its typed `memory.*` / numeric wire codes over a raw
 * message that may be terse.
 */
function formatMemoryError(error: unknown): string {
  const code = memoryErrorCode(error);
  switch (code) {
    case 'memory.version_conflict':
      return 'This memory changed since you opened it. Reopen it and retry.';
    case 'memory.trust_required':
    case 40926:
      return 'Trust this workspace before creating or updating project memory.';
    case 'memory.content_rejected':
    case 40927:
      return 'The content looks like a secret and was rejected.';
    case 'memory.scope_full':
    case 40929:
      return 'This scope is at capacity. Forget an existing memory first.';
    case 'memory.body_too_large':
    case 41306:
      return 'The memory body exceeds the size limit. Shorten it.';
    case 'memory.not_found':
    case 40418:
      return 'That memory no longer exists.';
    default:
      break;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
