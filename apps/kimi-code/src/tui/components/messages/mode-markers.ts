import { truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type ModeMarkerState = 'active' | 'inactive' | 'ended';

export class ModeMarkerComponent implements Component {
  constructor(
    private readonly state: ModeMarkerState,
    private readonly label: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, this.label);
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}
