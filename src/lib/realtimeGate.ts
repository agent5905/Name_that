export class RealtimeInvalidationGate {
  private nextAllowedAt = 0;
  private trailingQueued = false;

  consider(version: unknown, authoritativeVersion: number, now: number, fetchInFlight: boolean): number | null {
    if (typeof version !== 'number' || !Number.isInteger(version) || version <= authoritativeVersion) return null;
    if (!fetchInFlight && now >= this.nextAllowedAt) {
      this.nextAllowedAt = now + 1_000;
      return 0;
    }
    if (this.trailingQueued) return null;
    this.trailingQueued = true;
    return Math.max(1_000, this.nextAllowedAt - now);
  }

  consumeTrailing(now: number): void {
    this.trailingQueued = false;
    this.nextAllowedAt = now + 1_000;
  }

  reset(): void {
    this.trailingQueued = false;
    this.nextAllowedAt = 0;
  }
}

export function isPriorityPhaseInvalidation(
  version: unknown,
  authoritativeVersion: number,
  phase: unknown,
  authoritativePhase: string | null,
): boolean {
  return typeof version === 'number'
    && Number.isInteger(version)
    && version > authoritativeVersion
    && typeof phase === 'string'
    && phase !== authoritativePhase;
}
