import { describe, expect, it } from 'vitest';
import { RealtimeInvalidationGate } from './realtimeGate';

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
});
