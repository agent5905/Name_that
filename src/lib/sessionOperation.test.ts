import { describe, expect, it } from 'vitest';
import { newSessionOperation } from './sessionOperation';

describe('newSessionOperation', () => {
  it('creates a 256-bit base64url host token and an independent idempotency key', () => {
    const first = newSessionOperation();
    const second = newSessionOperation();
    expect(first.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toEqual(first);
  });
});
