import type { ParticipantJoinOperation, SessionCreationOperation } from '../domain/admin';

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newSessionOperation(): SessionCreationOperation {
  return { hostToken: randomToken(), idempotencyKey: crypto.randomUUID() };
}

export function newParticipantJoinOperation(): ParticipantJoinOperation {
  return { participantToken: randomToken(), idempotencyKey: crypto.randomUUID() };
}
