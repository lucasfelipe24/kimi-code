/** Formats an active duration (ms) into a compact "Xm Ys" / "Xh Ym" label. */
export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

export class TurnTiming {
  private _turnId: string | undefined;
  private _startedAtMs: number | undefined;
  private _pausedAtMs: number | undefined;
  private _pausedMs = 0;
  private _humanWaitCount = 0;
  private readonly _now: () => number;

  constructor(now?: () => number) {
    this._now = now ?? Date.now;
  }

  get startedAtMs(): number | undefined { return this._startedAtMs; }
  get paused(): boolean { return this._humanWaitCount > 0; }

  /** True when a turn has been started and not yet finished. */
  isActive(): boolean { return this._startedAtMs !== undefined; }

  start(turnId: string): void {
    this.reset();
    this._turnId = turnId;
    this._startedAtMs = this._now();
    this._pausedMs = 0;
    this._humanWaitCount = 0;
    this._pausedAtMs = undefined;
  }

  startHumanWait(): void {
    if (this._startedAtMs === undefined) return;
    if (this._humanWaitCount === 0) {
      this._pausedAtMs = this._now();
    }
    this._humanWaitCount++;
  }

  endHumanWait(): void {
    if (this._startedAtMs === undefined) return;
    if (this._humanWaitCount <= 0) return;
    this._humanWaitCount--;
    if (this._humanWaitCount === 0 && this._pausedAtMs !== undefined) {
      this._pausedMs += this._now() - this._pausedAtMs;
      this._pausedAtMs = undefined;
    }
  }

  activeElapsedMs(): number {
    if (this._startedAtMs === undefined) return 0;
    if (this._pausedAtMs !== undefined) {
      // Paused: frozen at the value when pause started
      return this._pausedAtMs - this._startedAtMs - this._pausedMs;
    }
    return this._now() - this._startedAtMs - this._pausedMs;
  }

  /** Finishes timing, returns active duration in ms, then resets state.
   *  Returns null if no turn was started. */
  finish(): { activeDurationMs: number } | null {
    if (this._startedAtMs === undefined) return null;
    // Close any open pause
    if (this._pausedAtMs !== undefined) {
      this._pausedMs += this._now() - this._pausedAtMs;
      this._pausedAtMs = undefined;
    }
    const activeDurationMs = Math.max(0, this._now() - this._startedAtMs - this._pausedMs);
    this.reset();
    return { activeDurationMs };
  }

  reset(): void {
    this._turnId = undefined;
    this._startedAtMs = undefined;
    this._pausedAtMs = undefined;
    this._pausedMs = 0;
    this._humanWaitCount = 0;
  }
}
