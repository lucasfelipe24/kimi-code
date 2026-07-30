export class TurnTiming {
  private _startedAtMs: number | undefined;
  private _pausedAtMs: number | undefined;
  private _pausedMs = 0;
  private _humanWaitCount = 0;
  private readonly _now: () => number;

  constructor(now?: () => number) {
    this._now = now ?? Date.now;
  }

  isActive(): boolean { return this._startedAtMs !== undefined; }
  isPaused(): boolean { return this._humanWaitCount > 0; }

  start(_turnId: string): void {
    this.reset();
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
      return this._pausedAtMs - this._startedAtMs - this._pausedMs;
    }
    return this._now() - this._startedAtMs - this._pausedMs;
  }

  finish(): { activeDurationMs: number } | null {
    if (this._startedAtMs === undefined) return null;
    if (this._pausedAtMs !== undefined) {
      this._pausedMs += this._now() - this._pausedAtMs;
      this._pausedAtMs = undefined;
    }
    const activeDurationMs = Math.max(0, this._now() - this._startedAtMs - this._pausedMs);
    this.reset();
    return { activeDurationMs };
  }

  reset(): void {
    this._startedAtMs = undefined;
    this._pausedAtMs = undefined;
    this._pausedMs = 0;
    this._humanWaitCount = 0;
  }
}
