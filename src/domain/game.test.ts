import { describe, expect, it } from 'vitest';
import { gamePhases, isGamePhase } from './game';

describe('game phase vocabulary', () => {
  it.each(gamePhases)('accepts the known %s phase', (phase) => {
    expect(isGamePhase(phase)).toBe(true);
  });

  it.each([undefined, null, '', 'open', 3, {}])(
    'rejects an unknown phase: %s',
    (value) => {
      expect(isGamePhase(value)).toBe(false);
    },
  );
});

