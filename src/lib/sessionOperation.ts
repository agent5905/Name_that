import type { SessionCreationOperation } from '../domain/admin';

export function newSessionOperation(): SessionCreationOperation {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hostToken = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { hostToken, idempotencyKey: crypto.randomUUID() };
}
