import { describe, expect, it } from 'vitest';
import { isPriorityPhaseInvalidation, RealtimeInvalidationGate } from './realtimeGate';

describe('RealtimeInvalidationGate', () => {
  it('coalesces a burst of 100 newer public broadcasts to one immediate and one trailing fetch', () => {
    const gate = new RealtimeInvalidationGate();
    const decisions = Array.from({ length: 100 }, () => gate.consider(99, 7, 10_000, false));
    expect(decisions.filter((delay) => delay === 0)).toHaveLength(1);
    expect(decisions.filter((delay) => delay === 1_000)).toHaveLength(1);
    expect(decisions.filter((delay) => delay === null)).toHaveLength(98);
  });

  it('ignores malformed, stale, and equal versions', () => {
    const gate = new RealtimeInvalidationGate();
    expect(gate.consider('99', 7, 10_000, false)).toBeNull();
    expect(gate.consider(7, 7, 10_000, false)).toBeNull();
    expect(gate.consider(6, 7, 10_000, false)).toBeNull();
  });

  it('resets a cancelled trailing invalidation before an urgent phase change', () => {
    const gate = new RealtimeInvalidationGate();
    expect(gate.consider(2, 1, 1_000, false)).toBe(0);
    expect(gate.consider(3, 1, 1_010, true)).toBe(1_000);
    gate.reset();
    expect(gate.consider(4, 3, 1_020, false)).toBe(0);
  });
});

describe('priority phase invalidations', () => {
  it('prioritizes only fresh authoritative phase changes', () => {
    expect(isPriorityPhaseInvalidation(8, 7, 'employee_revealed', 'answers_locked')).toBe(true);
    expect(isPriorityPhaseInvalidation(7, 7, 'answers_locked', 'employee_revealed')).toBe(false);
    expect(isPriorityPhaseInvalidation(6, 7, 'question_open', 'employee_revealed')).toBe(false);
    expect(isPriorityPhaseInvalidation(8, 7, 'answers_locked', 'answers_locked')).toBe(false);
  });
});
