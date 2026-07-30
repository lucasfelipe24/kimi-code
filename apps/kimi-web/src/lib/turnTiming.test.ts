import { describe, it, expect, beforeEach } from 'vitest';
import { TurnTiming } from './turnTiming';

describe('TurnTiming', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => { now = 0; });

  it('starts at 0 elapsed and not paused', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    expect(t.activeElapsedMs()).toBe(0);
    expect(t.isPaused()).toBe(false);
    expect(t.isActive()).toBe(true);
  });

  it('tracks elapsed time', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 5000;
    expect(t.activeElapsedMs()).toBe(5000);
  });

  it('pauses and resumes excluding wait time', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 3000;
    t.startHumanWait();
    expect(t.isPaused()).toBe(true);
    now = 10000;
    t.endHumanWait();
    expect(t.isPaused()).toBe(false);
    expect(t.activeElapsedMs()).toBe(3000);
    now = 12000;
    expect(t.activeElapsedMs()).toBe(5000);
  });

  it('finish returns duration and cleans up', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 5000;
    const r = t.finish();
    expect(r).toEqual({ activeDurationMs: 5000 });
    expect(t.isActive()).toBe(false);
  });

  it('finish with pause excludes wait time', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 2000;
    t.startHumanWait();
    now = 8000;
    const r = t.finish();
    expect(r).toEqual({ activeDurationMs: 2000 });
  });

  it('handles overlapping human waits', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 1000;
    t.startHumanWait();
    now = 3000;
    t.startHumanWait();
    now = 5000;
    t.endHumanWait();
    expect(t.isPaused()).toBe(true);
    now = 7000;
    t.endHumanWait();
    expect(t.isPaused()).toBe(false);
    now = 9000;
    // active = 9s total - 6s paused (1000→7000) = 3s
    expect(t.activeElapsedMs()).toBe(3000);
  });

  it('finish returns null when not started', () => {
    const t = new TurnTiming(clock);
    expect(t.finish()).toBeNull();
  });

  it('reset clears state', () => {
    const t = new TurnTiming(clock);
    t.start('t1');
    now = 5000;
    t.reset();
    expect(t.isActive()).toBe(false);
    expect(t.finish()).toBeNull();
  });
});
