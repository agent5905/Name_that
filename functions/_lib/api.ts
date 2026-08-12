import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
type SnapshotRow = {
  room_code: string; phase: string; round_index: number | null; round_count: number;
  connected_participant_count: number; submitted_answer_count: number; version: number;
  choices: Json; revealed_employee: Json; results: Json; updated_at: string;
};
export interface HostRoomResponse {
  readonly roomId: string;
  readonly code: string;
  readonly phase: string;
  readonly currentRound: number | null;
  readonly roundCount: number;
  readonly isFinalRound: boolean;
  readonly correctEmployee: {
    readonly id: string;
    readonly displayName: string;
    readonly team: string;
  } | null;
  readonly version: number;
}
interface Database {
  public: {
    Tables: {
      room_snapshots: { Row: SnapshotRow; Insert: never; Update: never; Relationships: [] };
    };
    Views: Record<never, never>;
    Functions: {
      create_room: { Args: { p_code: string; p_host_token_hash: string }; Returns: Json };
      join_room: { Args: { p_code: string; p_display_name: string; p_participant_token_hash: string }; Returns: Json };
      submit_answer: { Args: { p_code: string; p_player_id: string; p_participant_token_hash: string; p_employee_id: string }; Returns: Json };
      host_action: { Args: { p_code: string; p_host_token_hash: string; p_action: string }; Returns: Json };
      host_room: { Args: { p_code: string; p_host_token_hash: string }; Returns: HostRoomResponse };
      participant_answer: { Args: { p_code: string; p_player_id: string; p_participant_token_hash: string }; Returns: Json };
      reveal_media_path: { Args: { p_code: string; p_member_id: string }; Returns: string };
      consume_room_creation_attempt: { Args: { p_source_hash: string }; Returns: Json };
      cleanup_expired_rooms: { Args: Record<never, never>; Returns: Json };
      cleanup_stale_realtime_auth_users: { Args: Record<never, never>; Returns: Json };
    };
    Enums: { game_phase: string };
    CompositeTypes: Record<never, never>;
  };
}

export interface Env {
  readonly SUPABASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly SUPABASE_SECRET_KEY?: string;
}

const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

export function apiHandler(
  method: string,
  handler: (context: EventContext<Env, string, unknown>) => Promise<Response>,
): PagesFunction<Env> {
  return async (context) => {
    if (context.request.method !== method) {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` } }, 405);
    }
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      console.error('Unhandled API error', error instanceof Error ? error.message : 'unknown');
      return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
    }
  };
}

export async function readJson(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json.');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object');
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

export function adminClient(env: Env): SupabaseClient<Database> {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  if (!url || !env.SUPABASE_SECRET_KEY) throw new Error('Server Supabase configuration is missing.');
  return createClient<Database>(url, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function roomCode(value: unknown): string {
  if (typeof value !== 'string' || !ROOM_CODE.test(value)) throw new ApiError(400, 'INVALID_ROOM_CODE', 'Room code is invalid.');
  return value;
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_NAME', 'Display name is required.');
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 40) throw new ApiError(400, 'INVALID_NAME', 'Display name must be 1 to 40 characters.');
  return normalized;
}

export function uuid(value: unknown, field = 'ID'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, 'INVALID_ID', `${field} is invalid.`);
  return value;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match?.[1]) throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
  return match[1];
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function roomCreationSourceHash(request: Request): Promise<string> {
  const candidate = request.headers.get('cf-connecting-ip')?.trim();
  const source = candidate && candidate.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(candidate)
    ? `cf-ip:${candidate.toLowerCase()}`
    : 'local-development-fallback';
  return tokenHash(source);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function requireAction(value: unknown): 'start' | 'lock' | 'reveal' | 'show_results' | 'next_round' | 'end' {
  const actions = ['start', 'lock', 'reveal', 'show_results', 'next_round', 'end'] as const;
  if (typeof value !== 'string' || !actions.some((action) => action === value)) {
    throw new ApiError(400, 'INVALID_ACTION', 'Host action is invalid.');
  }
  return value as (typeof actions)[number];
}

interface ServiceError { readonly message: string; readonly code?: string }

export function throwRpcError(error: ServiceError): never {
  const marker = [error.message, error.code].join(' ');
  const mappings: ReadonlyArray<[string, number, string, string]> = [
    ['ROOM_NOT_FOUND', 404, 'ROOM_NOT_FOUND', 'Room was not found.'],
    ['ROOM_NOT_JOINABLE', 409, 'ROOM_NOT_JOINABLE', 'Room is no longer accepting participants.'],
    ['ROOM_FULL', 409, 'ROOM_FULL', 'Room has reached its 100-player limit.'],
    ['CODE_COLLISION', 409, 'CODE_COLLISION', 'Room code collision.'],
    ['PARTICIPANT_UNAUTHORIZED', 403, 'PARTICIPANT_UNAUTHORIZED', 'Participant credential does not match this room and player.'],
    ['HOST_UNAUTHORIZED', 403, 'HOST_UNAUTHORIZED', 'Host credential is invalid.'],
    ['ANSWERS_CLOSED', 409, 'ANSWERS_CLOSED', 'Answers are closed.'],
    ['ANSWER_IMMUTABLE', 409, 'ANSWER_IMMUTABLE', 'The submitted answer cannot be changed.'],
    ['INVALID_CHOICE', 400, 'INVALID_CHOICE', 'Choice is not valid for this round.'],
    ['ILLEGAL_TRANSITION', 409, 'ILLEGAL_TRANSITION', 'Action is not valid in the current phase.'],
    ['MEDIA_NOT_REVEALED', 404, 'MEDIA_NOT_AVAILABLE', 'Media is not available.'],
    ['CONTENT_UNAVAILABLE', 503, 'CONTENT_UNAVAILABLE', 'Game content is unavailable.'],
  ];
  const found = mappings.find(([needle]) => marker.includes(needle));
  if (found) throw new ApiError(found[1], found[2], found[3]);
  throw new ApiError(500, 'DATA_SERVICE_ERROR', 'The data service could not complete the request.');
}

export function normalizeSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return {
    roomCode: row.room_code,
    phase: row.phase,
    roundIndex: row.round_index,
    roundCount: row.round_count,
    connectedParticipantCount: row.connected_participant_count,
    submittedAnswerCount: row.submitted_answer_count,
    version: row.version,
    choices: row.choices,
    revealedEmployee: row.revealed_employee,
    results: row.results,
    updatedAt: row.updated_at,
  };
}

function rpcObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid data service response.');
  return value as Record<string, unknown>;
}

function rpcString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid data service response.');
  return value;
}

function rpcUuid(value: unknown): string {
  const result = rpcString(value);
  if (!UUID.test(result)) throw new Error('Invalid data service response.');
  return result;
}

function rpcInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid data service response.');
  return value;
}

export interface CreatedRoomResponse { readonly roomId: string; readonly code: string }
export function parseCreatedRoom(value: unknown): CreatedRoomResponse {
  const row = rpcObject(value);
  const code = rpcString(row.code);
  if (!ROOM_CODE.test(code)) throw new Error('Invalid data service response.');
  return { roomId: rpcUuid(row.roomId), code };
}

export interface RoomCreationLimitResponse {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}
export function parseRoomCreationLimit(value: unknown): RoomCreationLimitResponse {
  const row = rpcObject(value);
  if (typeof row.allowed !== 'boolean') throw new Error('Invalid data service response.');
  const limit = rpcInteger(row.limit);
  const remaining = rpcInteger(row.remaining);
  const retryAfterSeconds = rpcInteger(row.retryAfterSeconds);
  if (limit !== 5 || remaining < 0 || remaining > limit || retryAfterSeconds < 0 || (row.allowed ? retryAfterSeconds !== 0 : retryAfterSeconds < 1)) {
    throw new Error('Invalid data service response.');
  }
  return { allowed: row.allowed, limit, remaining, retryAfterSeconds };
}

export interface CleanupRoomsResponse { readonly deletedRooms: number; readonly deletedSnapshots: number }
export function parseCleanupRooms(value: unknown): CleanupRoomsResponse {
  const row = rpcObject(value);
  const deletedRooms = rpcInteger(row.deletedRooms);
  const deletedSnapshots = rpcInteger(row.deletedSnapshots);
  if (deletedRooms < 0 || deletedSnapshots < 0 || deletedSnapshots > deletedRooms) throw new Error('Invalid data service response.');
  return { deletedRooms, deletedSnapshots };
}

export interface CleanupRealtimeAuthResponse { readonly deletedUsers: number }
export function parseCleanupRealtimeAuth(value: unknown): CleanupRealtimeAuthResponse {
  const row = rpcObject(value);
  const deletedUsers = rpcInteger(row.deletedUsers);
  if (deletedUsers < 0) throw new Error('Invalid data service response.');
  return { deletedUsers };
}

export interface JoinedParticipantResponse {
  readonly playerId: string;
  readonly roomId: string;
  readonly displayName: string;
}
export function parseJoinedParticipant(value: unknown): JoinedParticipantResponse {
  const row = rpcObject(value);
  const name = rpcString(row.displayName);
  if (name.trim() !== name || name.length < 1 || name.length > 40) throw new Error('Invalid data service response.');
  return {
    playerId: rpcUuid(row.playerId),
    roomId: rpcUuid(row.roomId),
    displayName: name,
  };
}

export interface SubmittedAnswerResponse {
  readonly accepted: boolean;
  readonly idempotent: boolean;
  readonly employeeId: string;
}
export function parseSubmittedAnswer(value: unknown): SubmittedAnswerResponse {
  const row = rpcObject(value);
  if (row.accepted !== true || typeof row.idempotent !== 'boolean') throw new Error('Invalid data service response.');
  return { accepted: true, idempotent: row.idempotent, employeeId: rpcUuid(row.employeeId) };
}

export function parseHostRoom(value: unknown): HostRoomResponse {
  const row = rpcObject(value);
  const currentRound = row.currentRound === null ? null : rpcInteger(row.currentRound);
  const correct = row.correctEmployee === null ? null : rpcObject(row.correctEmployee);
  if (typeof row.isFinalRound !== 'boolean') throw new Error('Invalid data service response.');
  const phases = ['lobby', 'question_open', 'answers_locked', 'employee_revealed', 'results_displayed', 'complete'];
  const phase = rpcString(row.phase);
  if (!phases.includes(phase)) throw new Error('Invalid data service response.');
  const code = rpcString(row.code);
  if (!ROOM_CODE.test(code)) throw new Error('Invalid data service response.');
  const roundCount = rpcInteger(row.roundCount);
  const version = rpcInteger(row.version);
  if (roundCount < 1 || version < 1) throw new Error('Invalid data service response.');
  if (currentRound === null) {
    if (correct !== null || row.isFinalRound || phase !== 'lobby') throw new Error('Invalid data service response.');
  } else if (currentRound < 0 || currentRound >= roundCount || correct === null || row.isFinalRound !== (currentRound === roundCount - 1)) {
    throw new Error('Invalid data service response.');
  }
  return {
    roomId: rpcUuid(row.roomId),
    code,
    phase,
    currentRound,
    roundCount,
    isFinalRound: row.isFinalRound,
    correctEmployee: correct ? {
      id: rpcUuid(correct.id),
      displayName: rpcString(correct.displayName),
      team: rpcString(correct.team),
    } : null,
    version,
  };
}
