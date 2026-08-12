import type {
  GameSnapshot,
  HostAction,
  HostRoom,
  Participant,
  ParticipantSnapshot,
} from '../domain/game';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly token?: string;
  readonly playerId?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.playerId) headers.set('x-player-id', options.playerId);
  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', 'We could not reach the game. Check your connection and try again.', 0);
  }
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new ApiError(detail?.code ?? 'REQUEST_FAILED', detail?.message ?? 'The request could not be completed.', response.status);
  }
  return payload as T;
}

export async function createRoom(): Promise<{ room: { roomId: string; code: string }; hostToken: string }> {
  return requestJson('/api/rooms', { method: 'POST', body: {} });
}

export async function joinRoom(code: string, name: string): Promise<{ participant: Participant; participantToken: string }> {
  return requestJson(`/api/rooms/${code}/join`, { method: 'POST', body: { name } });
}

export async function getSnapshot(
  code: string,
  session?: { token: string; playerId: string },
  signal?: AbortSignal,
): Promise<{ snapshot: GameSnapshot; participant?: ParticipantSnapshot }> {
  return requestJson(`/api/rooms/${code}/snapshot`, {
    ...(session ? { token: session.token, playerId: session.playerId } : {}),
    ...(signal ? { signal } : {}),
  });
}

export async function getHostRoom(code: string, token: string): Promise<{ host: HostRoom }> {
  return requestJson(`/api/rooms/${code}/host`, { token });
}

export async function submitAnswer(code: string, token: string, playerId: string, choiceId: string) {
  return requestJson<{ answer: { accepted: boolean; idempotent: boolean; employeeId: string } }>(
    `/api/rooms/${code}/answers`,
    { method: 'POST', token, body: { playerId, choiceId } },
  );
}

export async function performHostAction(code: string, token: string, action: HostAction) {
  return requestJson<{ snapshot: GameSnapshot }>(`/api/rooms/${code}/actions`, {
    method: 'POST', token, body: { action },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something unexpected happened. Please try again.';
}
