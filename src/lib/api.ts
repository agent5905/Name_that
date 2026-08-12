import type {
  GameSnapshot,
  HostAction,
  HostRoom,
  Participant,
  ParticipantSnapshot,
} from '../domain/game';
import type { AdminSession, CreatedRoom, GameDefinition, GameSummary, SessionCreationOperation } from '../domain/admin';

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
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly token?: string;
  readonly playerId?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.playerId) headers.set('x-player-id', options.playerId);
  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) }),
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

function unwrap<T>(payload: T | { game: T }): T {
  return payload && typeof payload === 'object' && 'game' in payload ? payload.game : payload;
}

export async function createAdminSession(): Promise<AdminSession> {
  const payload = await requestJson<{ admin: { id: string }; adminToken: string }>('/api/admin/session', { method: 'POST', body: {} });
  return { id: payload.admin.id, token: payload.adminToken };
}

export async function listGames(token: string): Promise<readonly GameSummary[]> {
  const payload = await requestJson<readonly GameSummary[] | { games: readonly GameSummary[] }>('/api/games', { token });
  return 'games' in payload ? payload.games : payload;
}

export async function getGame(id: string, token: string): Promise<GameDefinition> {
  return unwrap(await requestJson<GameDefinition | { game: GameDefinition }>(`/api/games/${id}`, { token }));
}

export async function createGame(token: string, definition: Pick<GameDefinition, 'name' | 'questions'>): Promise<GameDefinition> {
  return unwrap(await requestJson<GameDefinition | { game: GameDefinition }>('/api/games', { method: 'POST', token, body: definition }));
}

export async function updateGame(token: string, definition: GameDefinition): Promise<GameDefinition> {
  return unwrap(await requestJson<GameDefinition | { game: GameDefinition }>(`/api/games/${definition.id}`, {
    method: 'PUT', token, body: { name: definition.name, revision: definition.revision, questions: definition.questions },
  }));
}

export async function deleteGame(id: string, token: string): Promise<void> {
  await requestJson(`/api/games/${id}`, { method: 'DELETE', token });
}

export async function uploadGameMedia(id: string, token: string, file: File): Promise<{ id: string; mimeType: string; previewUrl: string }> {
  const form = new FormData();
  form.set('file', file);
  const payload = await requestJson<{ media: { id: string; mimeType: string; previewUrl: string } }>(`/api/games/${id}/media`, {
    method: 'POST', token, body: form,
  });
  return payload.media;
}

export async function loadGameMediaPreview(path: string, token: string): Promise<string> {
  return URL.createObjectURL(await loadGameMediaBlob(path, token));
}

export async function loadGameMediaBlob(path: string, token: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'We could not load this image preview.', 0);
  }
  if (!response.ok) throw new ApiError('MEDIA_PREVIEW_FAILED', 'We could not load this image preview.', response.status);
  return response.blob();
}

export async function createGameRoom(id: string, token: string, operation: SessionCreationOperation): Promise<{ room: CreatedRoom; hostToken: string }> {
  return requestJson(`/api/games/${id}/sessions`, { method: 'POST', token, body: operation });
}

export async function playAgain(code: string, token: string, operation: SessionCreationOperation): Promise<{ room: CreatedRoom; hostToken: string }> {
  return requestJson(`/api/rooms/${code}/play-again`, { method: 'POST', token, body: operation });
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
