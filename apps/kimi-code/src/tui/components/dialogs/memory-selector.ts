import type { MemorySummary } from '@moonshot-ai/kimi-code-sdk';
import { Container, Key, matchesKey, truncateToWidth, type Focusable } from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';

export interface MemorySelectorOptions {
  readonly memories: readonly MemorySummary[];
  /** Create a new memory (opens the editor). */
  readonly onCreate: () => void;
  /** Edit the memory under the cursor (opens the editor). */
  readonly onEdit: (memory: MemorySummary) => void;
  /** View the full body of the memory under the cursor. */
  readonly onView: (memory: MemorySummary) => void;
  /** Forget the memory under the cursor. The host refreshes the list. */
  readonly onForget: (memory: MemorySummary) => void;
  readonly onCancel: () => void;
}

/**
 * Native persistent-memory manager for the v2 SDK.
 *
 * A searchable list with full management: create (`N`) and edit (`E`) open the
 * memory as a markdown document in `$EDITOR`, `Enter` views the full body, and
 * `D` forgets (two-step confirm inline). The agent manages the same durable
 * store through its Memory tool.
 */
export class MemorySelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: MemorySelectorOptions;
  private readonly list: SearchableList<MemorySummary>;
  /** Id pending delete confirmation, or undefined when none is armed. */
  private confirmId: string | undefined;

  constructor(opts: MemorySelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.memories,
      toSearchText: (m) => `${m.name} ${m.description} ${m.scope} ${m.type} ${m.body}`,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.confirmId !== undefined) {
        this.confirmId = undefined;
        return;
      }
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }

    const selected = this.list.selected();

    // Two-step delete confirmation: `D` arms, `Y` confirms, anything else cancels.
    if (this.confirmId !== undefined) {
      const ch = printableChar(data);
      if (ch === 'y' || ch === 'Y') {
        const target = this.opts.memories.find((m) => m.id === this.confirmId);
        this.confirmId = undefined;
        if (target !== undefined) this.opts.onForget(target);
        return;
      }
      // Any other key cancels the confirmation without deleting.
      this.confirmId = undefined;
      return;
    }

    // `Enter` views the full body of the selected memory.
    if (matchesKey(data, Key.enter)) {
      if (selected !== undefined) this.opts.onView(selected);
      return;
    }

    const decoded = printableChar(data);
    // Action letters are printable, so they would otherwise land in the search
    // query — intercept them before the list consumes them (same trade-off the
    // component already makes for delete: these letters don't reach search).
    if (decoded === 'N' || decoded === 'n') {
      this.opts.onCreate();
      return;
    }
    if ((decoded === 'E' || decoded === 'e') && selected !== undefined) {
      this.opts.onEdit(selected);
      return;
    }
    if ((decoded === 'D' || decoded === 'd') && selected !== undefined) {
      this.confirmId = selected.id;
      return;
    }

    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('PgUp/PgDn page');
    hintParts.push('N new', 'E edit', '⏎ view', 'D delete', 'Esc cancel');
    if (view.query.length > 0) hintParts.push('Backspace clear');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Persistent memory') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No memories — press N to create one'));
    }

    for (let i = view.page.start; i < view.page.end; i++) {
      const memory = view.items[i]!;
      const selected = i === view.selectedIndex;
      lines.push(...this.renderMemory(memory, selected, width));
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${String(view.items.length)} / ${String(this.opts.memories.length)}`,
        ),
      );
    } else if (view.page.end < view.items.length) {
      lines.push(
        currentTheme.fg('textMuted', ` ▼ ${String(view.items.length - view.page.end)} more`),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderMemory(memory: MemorySummary, selected: boolean, width: number): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const name = selected
      ? currentTheme.boldFg('primary', memory.name)
      : currentTheme.fg('text', memory.name);
    const origin = currentTheme.fg('textMuted', memory.origin);
    const head = `${prefix}${name}  ${origin}`;

    const detail = currentTheme.fg('textMuted', `    ${memory.type} · ${memory.description}`);
    const lines = [head, detail];

    if (selected && this.confirmId === memory.id) {
      lines.push(currentTheme.boldFg('warning', `    Forget this memory? [y/N]`));
    }
    void width;
    return lines;
  }
}
