import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
type SnapshotRow = {
  room_code: string; phase: string; round_index: number | null; round_count: number;
  connected_participant_count: number; eligible_participant_count?: number; submitted_answer_count: number; version: number;
  choices: Json; revealed_employee: Json; results: Json; updated_at: string;
  mystery_image_url?:string|null;preload_assets?:Json;
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
      join_room: { Args: { p_code: string; p_display_name: string; p_participant_token_hash: string; p_join_operation_id?: string }; Returns: Json };
      submit_answer: { Args: { p_code: string; p_player_id: string; p_participant_token_hash: string; p_employee_id: string }; Returns: Json };
      host_action: { Args: { p_code: string; p_host_token_hash: string; p_action: string }; Returns: Json };
      host_room: { Args: { p_code: string; p_host_token_hash: string }; Returns: HostRoomResponse };
      participant_answer: { Args: { p_code: string; p_player_id: string; p_participant_token_hash: string }; Returns: Json };
      reveal_media_path: { Args: { p_code: string; p_member_id: string }; Returns: Json };
      consume_room_creation_attempt: { Args: { p_source_hash: string }; Returns: Json };
      consume_saved_session_attempt: { Args: { p_source_hash: string }; Returns: Json };
      consume_media_upload_attempt: { Args: { p_admin_token_hash: string }; Returns: Json };
      consume_admin_profile_attempt: { Args: { p_source_hash: string }; Returns: Json };
      consume_media_source_attempt: { Args: { p_source_hash: string }; Returns: Json };
      reserve_media_source_bytes: { Args: { p_source_hash: string; p_byte_size: number }; Returns: Json };
      reserve_project_media_bytes: { Args: { p_byte_size: number }; Returns: Json };
      cleanup_stale_studio_state: { Args: Record<never, never>; Returns: Json };
      consume_game_mutation_attempt: { Args: { p_admin_token_hash:string }; Returns: Json };
      cleanup_expired_rooms: { Args: Record<never, never>; Returns: Json };
      cleanup_stale_realtime_auth_users: { Args: Record<never, never>; Returns: Json };
      create_admin_profile: { Args: { p_admin_token_hash: string }; Returns: Json };
      admin_owner_id: { Args: { p_admin_token_hash: string }; Returns: string };
      create_game_definition: { Args: { p_admin_token_hash: string; p_source_hash:string;p_name: string; p_questions: Json }; Returns: Json };
      list_game_definitions: { Args: { p_admin_token_hash: string }; Returns: Json };
      get_game_definition: { Args: { p_admin_token_hash: string; p_game_id: string }; Returns: Json };
      update_game_definition: { Args: { p_admin_token_hash: string;p_source_hash:string; p_game_id: string; p_revision: number; p_name: string; p_questions: Json }; Returns: Json };
      delete_game_definition: { Args: { p_admin_token_hash: string;p_source_hash:string; p_game_id: string }; Returns: Json };
      register_game_media: { Args: { p_admin_token_hash: string; p_game_id: string; p_storage_path: string; p_silhouette_storage_path: string; p_mime_type: string; p_silhouette_mime_type:string; p_byte_size: number }; Returns: Json };
      complete_game_media: { Args: { p_admin_token_hash: string; p_game_id: string; p_media_id: string }; Returns: Json };
      claim_game_media_gc: { Args: { p_admin_token_hash: string }; Returns: Json };
      finalize_game_media_gc: { Args: { p_admin_token_hash: string; p_media_ids: string[] }; Returns: Json };
      owner_game_media_paths: { Args: { p_admin_token_hash: string }; Returns: Json };
      get_game_media: { Args: { p_admin_token_hash: string; p_game_id: string; p_media_id: string }; Returns: Json };
      create_game_session: { Args: { p_admin_token_hash: string; p_game_id: string; p_code: string; p_host_token_hash: string; p_idempotency_key: string }; Returns: Json };
      play_again_session: { Args: { p_code: string; p_host_token_hash: string; p_new_code: string; p_new_host_token_hash: string; p_idempotency_key: string }; Returns: Json };
      silhouette_media_path: { Args: { p_code: string }; Returns: Json };
      register_game_media_pair: { Args: { p_admin_token_hash:string;p_source_hash:string;p_game_id:string;p_mystery_path:string;p_reveal_path:string;p_mystery_mime:string;p_reveal_mime:string;p_mystery_bytes:number;p_reveal_bytes:number }; Returns: Json };
      complete_game_media_pair: { Args: { p_admin_token_hash:string;p_game_id:string;p_media_id:string }; Returns: Json };
      get_game_media_role: { Args: { p_admin_token_hash:string;p_game_id:string;p_media_id:string;p_role:string }; Returns: Json };
      room_preload_media: { Args: { p_code:string;p_round:number;p_asset_id:string;p_kind:string }; Returns: Json };
      current_mystery_media_path: { Args: { p_code:string }; Returns: Json };
      reveal_preload_key: { Args: { p_code:string;p_choice_id:string }; Returns: Json };
    };
    Enums: { game_phase: string };
    CompositeTypes: Record<never, never>;
  };
}

export interface Env {
  readonly SUPABASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly SUPABASE_SECRET_KEY?: string;
  readonly SUPABASE_REALTIME_ANON_KEY?: string;
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

export function opaqueToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new ApiError(400,'INVALID_TOKEN','A valid opaque token is required.');
  return value;
}

function decodeJwtPart(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid jwt encoding');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('invalid jwt object');
  return decoded as Record<string, unknown>;
}

export function realtimeAnonToken(env: Env, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const token = env.SUPABASE_REALTIME_ANON_KEY;
  const unavailable = () => new ApiError(503, 'REALTIME_UNAVAILABLE', 'Realtime is temporarily unavailable.');
  if (typeof token !== 'string' || token.length < 100 || token.length > 2_048) throw unavailable();
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{32,}$/.test(parts[2] ?? '')) throw unavailable();
  try {
    const header = decodeJwtPart(parts[0] ?? '');
    const claims = decodeJwtPart(parts[1] ?? '');
    if (header.alg !== 'HS256' || claims.role !== 'anon'
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp)
      || claims.exp <= nowSeconds + 300) throw unavailable();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
  return token;
}

export function parseMediaLocation(value:unknown):{storagePath:string;mimeType:string}{const row=rpcObject(value);const path=rpcString(row.storagePath);const mime=rpcString(row.mimeType);if(!/^(portraits|game-media)\//.test(path)||!['image/jpeg','image/png','image/webp'].includes(mime))throw new Error('Invalid data service response.');return{storagePath:path,mimeType:mime};}
export function roomMediaRole(value:unknown):'mystery'|'reveal'{if(value==='mystery'||value==='reveal')return value;throw new ApiError(400,'INVALID_MEDIA_ROLE','Image role is invalid.');}
export function preloadQuery(request:Request):{round:number;asset:string}{const raw=new URL(request.url).search;if(!/^\?round=(0|[1-9]\d?)&asset=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw))throw new ApiError(400,'INVALID_PRELOAD_ROUND','Preload URL is invalid.');const query=new URLSearchParams(raw);return{round:Number(query.get('round')),asset:uuid(query.get('asset'),'Session asset')};}
export function preloadCacheKey(request:Request,code:string,kind:'mystery'|'reveal',round:number,asset:string):Request{
 const origin=new URL(request.url).origin;const canonical=new URL(`/api/rooms/${code}/${kind}-preload`,origin);canonical.search=`?round=${round}&asset=${asset}`;return new Request(canonical.toString(),{method:'GET'});
}

export function parsePreloadLocation(value:unknown,kind:'mystery'|'reveal'):{storagePath:string;mimeType:string;roundIndex:number;key?:string;iv?:string;aad?:string}{
 const row=rpcObject(value);const storagePath=rpcString(row.storagePath);const mimeType=rpcString(row.mimeType);const roundIndex=rpcInteger(row.roundIndex);
 if(!storagePath.startsWith('game-media/')||roundIndex<0||roundIndex>99||!['image/png','image/jpeg','image/webp'].includes(mimeType))throw new Error('Invalid data service response.');
 if(kind==='reveal'){const key=rpcString(row.key),iv=rpcString(row.iv),aad=rpcString(row.aad);if(!/^[A-Za-z0-9_-]{43}$/.test(key)||!/^[A-Za-z0-9_-]{16}$/.test(iv)||aad.length<1||aad.length>160||!['image/png','image/jpeg','image/webp'].includes(mimeType))throw new Error('Invalid data service response.');return{storagePath,mimeType,roundIndex,key,iv,aad};}return{storagePath,mimeType,roundIndex};
}

export function parseRevealKey(value:unknown):{key:string;iv:string;mimeType:string;aad:string}{const row=rpcObject(value);const key=rpcString(row.key),iv=rpcString(row.iv),mimeType=rpcString(row.mimeType),aad=rpcString(row.aad);if(!/^[A-Za-z0-9_-]{43}$/.test(key)||!/^[A-Za-z0-9_-]{16}$/.test(iv)||!['image/png','image/jpeg','image/webp'].includes(mimeType)||aad.length<1||aad.length>160)throw new Error('Invalid data service response.');return{key,iv,mimeType,aad};}

function parsePreloadAssets(value:unknown,expectedCode:string):ReadonlyArray<{key:string;kind:'mystery'|'reveal-encrypted';roundIndex:number;url:string}>{
 if(!Array.isArray(value)||value.length>4)throw new Error('Invalid data service response.');return value.map(raw=>{const row=rpcObject(raw);const key=rpcString(row.key),rawKind=rpcString(row.kind),roundIndex=rpcInteger(row.roundIndex),url=rpcString(row.url);const kind:'mystery'|'reveal-encrypted'=rawKind==='mystery'?'mystery':rawKind==='reveal-encrypted'?'reveal-encrypted':(()=>{throw new Error('Invalid data service response.');})();const keyKind=kind==='mystery'?'mystery':'reveal';let parsed:URL;try{parsed=new URL(url,'https://local.invalid');}catch{throw new Error('Invalid data service response.');}const params=[...parsed.searchParams.keys()];const asset=parsed.searchParams.get('asset'),round=parsed.searchParams.get('round');if(roundIndex<0||roundIndex>99||key!==`${expectedCode}:${roundIndex}:${keyKind}`||parsed.origin!=='https://local.invalid'||parsed.pathname!==`/api/rooms/${expectedCode}/${keyKind}-preload`||params.length!==2||params[0]!=='round'||params[1]!=='asset'||round!==String(roundIndex)||!asset||!UUID.test(asset))throw new Error('Invalid data service response.');return{key,kind,roundIndex,url};});
}

export function idempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key');
  return value ? uuid(value, 'Idempotency key') : crypto.randomUUID();
}

export async function derivedToken(secret: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(purpose));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
    ['GAME_ENDED', 410, 'GAME_ENDED', 'This game has ended. Ask the host for the new room code.'],
    ['GAME_NOT_FOUND', 404, 'GAME_NOT_FOUND', 'Game was not found.'],
    ['MEDIA_NOT_FOUND', 404, 'MEDIA_NOT_FOUND', 'Image was not found.'],
    ['ADMIN_UNAUTHORIZED', 403, 'ADMIN_UNAUTHORIZED', 'Admin credential is invalid.'],
    ['REVISION_CONFLICT', 409, 'REVISION_CONFLICT', 'This game changed in another tab. Reload before saving.'],
    ['GAME_MEDIA_REQUIRED', 422, 'GAME_MEDIA_REQUIRED', 'Every question needs a reveal image before hosting.'],
    ['GAME_QUOTA_EXCEEDED', 409, 'GAME_QUOTA_EXCEEDED', 'This studio has reached its saved-game limit.'],
    ['PROJECT_GAME_CAPACITY_REACHED', 503, 'PROJECT_GAME_CAPACITY_REACHED', 'Saved-game capacity is temporarily full.'],
    ['PROJECT_GAME_DAILY_LIMITED',503,'PROJECT_GAME_DAILY_LIMITED','Daily saved-game capacity is temporarily full.'],
    ['GAME_SOURCE_DAILY_LIMITED',429,'GAME_SOURCE_DAILY_LIMITED','This network has reached its daily saved-game allowance.'],
    ['PROJECT_MEDIA_DAILY_LIMITED', 503, 'PROJECT_MEDIA_DAILY_LIMITED', 'Daily image capacity is temporarily full.'],
    ['MEDIA_SOURCE_DAILY_LIMITED', 429, 'MEDIA_UPLOAD_BYTE_LIMITED', 'This network has reached its daily image allowance.'],
    ['MEDIA_QUOTA_EXCEEDED', 409, 'MEDIA_QUOTA_EXCEEDED', 'This studio has reached its private media limit.'],
    ['PROJECT_MEDIA_CAPACITY_REACHED', 503, 'PROJECT_MEDIA_CAPACITY_REACHED', 'Image capacity is temporarily full. Try again later.'],
    ['SESSION_QUOTA_EXCEEDED', 429, 'SESSION_QUOTA_EXCEEDED', 'Too many sessions are active or recently retained.'],
    ['INVALID_GAME', 422, 'INVALID_GAME', 'The saved game definition is invalid.'],
    ['INVALID_QUESTION', 422, 'INVALID_GAME', 'A question is invalid.'],
    ['INVALID_CHOICE', 400, 'INVALID_CHOICE', 'Choice is not valid for this round.'],
    ['IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used.'],
    ['PLAY_AGAIN_UNAVAILABLE', 409, 'PLAY_AGAIN_UNAVAILABLE', 'This room cannot be played again.'],
    ['ROOM_FULL', 409, 'ROOM_FULL', 'Room has reached its 225-player limit.'],
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
  const normalizedCode=rpcString(row.room_code);
  return {
    roomCode: normalizedCode,
    phase: row.phase,
    roundIndex: row.round_index,
    roundCount: row.round_count,
    connectedParticipantCount: row.connected_participant_count,
    eligibleParticipantCount: row.eligible_participant_count ?? row.connected_participant_count,
    submittedAnswerCount: row.submitted_answer_count,
    version: row.version,
    choices: row.choices,
    prompt: row.prompt ?? null,
    silhouetteUrl: row.silhouette_url ?? null,
    mysteryImageUrl: row.mystery_image_url ?? row.silhouette_url ?? null,
    preloadAssets: parsePreloadAssets(row.preload_assets ?? [],normalizedCode),
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

export interface SavedSessionResponse extends CreatedRoomResponse {
  readonly gameId: string; readonly gameRevision: number; readonly gameName: string;
}
export function parseSavedSession(value: unknown): SavedSessionResponse {
  const base = parseCreatedRoom(value); const row=rpcObject(value); const name=rpcString(row.gameName);
  const revision=rpcInteger(row.gameRevision);
  if(name.trim()!==name || name.length<1 || name.length>100 || revision<1) throw new Error('Invalid data service response.');
  return {...base,gameId:rpcUuid(row.gameId),gameRevision:revision,gameName:name};
}

export function parseAdmin(value: unknown): { readonly id: string } { return {id:rpcUuid(rpcObject(value).id)}; }

export function parseMedia(value: unknown): {readonly id:string;readonly mimeType:string;readonly byteSize:number;readonly previewUrl:string} {
  const row=rpcObject(value);const mime=rpcString(row.mimeType);const size=rpcInteger(row.byteSize);const preview=rpcString(row.previewUrl);
  if(!['image/jpeg','image/png','image/webp'].includes(mime)||size<1||size>5242880||!preview.startsWith('/api/games/')) throw new Error('Invalid data service response.');
  return {id:rpcUuid(row.id),mimeType:mime,byteSize:size,previewUrl:preview};
}
export function parseMediaPair(value:unknown):{readonly id:string;readonly mysteryMimeType:string;readonly revealMimeType:string;readonly mysteryByteSize:number;readonly revealByteSize:number;readonly mysteryPreviewUrl:string;readonly revealPreviewUrl:string}{
 const r=rpcObject(value);const mysteryMimeType=rpcString(r.mysteryMimeType),revealMimeType=rpcString(r.revealMimeType);const mysteryByteSize=rpcInteger(r.mysteryByteSize),revealByteSize=rpcInteger(r.revealByteSize);const mysteryPreviewUrl=rpcString(r.mysteryPreviewUrl),revealPreviewUrl=rpcString(r.revealPreviewUrl);
 if(!['image/png','image/jpeg','image/webp'].includes(mysteryMimeType)||!['image/png','image/jpeg','image/webp'].includes(revealMimeType)||mysteryByteSize<1||mysteryByteSize>5242880||revealByteSize<1||revealByteSize>5242880||!mysteryPreviewUrl.endsWith('/mystery')||!revealPreviewUrl.endsWith('/reveal'))throw new Error('Invalid data service response.');
 return{id:rpcUuid(r.id),mysteryMimeType,revealMimeType,mysteryByteSize,revealByteSize,mysteryPreviewUrl,revealPreviewUrl};
}

export interface GameChoiceDefinition {readonly id:string;readonly position:number;readonly text:string;readonly isCorrect:boolean}
export interface GameQuestionDefinition {readonly id:string;readonly position:number;readonly prompt:string;readonly revealName:string;readonly mysteryMediaAssetId:string|null;readonly revealMediaAssetId:string|null;readonly mysteryMediaPreviewUrl:string|null;readonly revealMediaPreviewUrl:string|null;readonly funFact:string|null;readonly choices:readonly GameChoiceDefinition[]}
export interface GameDefinition {readonly id:string;readonly name:string;readonly revision:number;readonly createdAt:string;readonly updatedAt:string;readonly questions:readonly GameQuestionDefinition[]}
export function parseGameDefinition(value:unknown):GameDefinition {
  const row=rpcObject(value);const questions=Array.isArray(row.questions)?row.questions.map((raw,qIndex)=>{const q=rpcObject(raw);const choices=Array.isArray(q.choices)?q.choices.map((r,cIndex)=>{const c=rpcObject(r);const position=rpcInteger(c.position);if(position!==cIndex||typeof c.isCorrect!=='boolean')throw new Error('Invalid data service response.');return{id:rpcUuid(c.id),position,text:rpcString(c.text),isCorrect:c.isCorrect};}):(()=>{throw new Error('Invalid data service response.');})();const position=rpcInteger(q.position);if(position!==qIndex||choices.filter(c=>c.isCorrect).length!==1)throw new Error('Invalid data service response.');const mysteryMediaAssetId=q.mysteryMediaAssetId===null?null:rpcUuid(q.mysteryMediaAssetId);const revealMediaAssetId=q.revealMediaAssetId===null?null:rpcUuid(q.revealMediaAssetId);const mysteryMediaPreviewUrl=q.mysteryMediaPreviewUrl===null?null:rpcString(q.mysteryMediaPreviewUrl);const revealMediaPreviewUrl=q.revealMediaPreviewUrl===null?null:rpcString(q.revealMediaPreviewUrl);const funFact=q.funFact===null?null:rpcString(q.funFact);if(mysteryMediaAssetId!==revealMediaAssetId||(funFact?.length??0)>500)throw new Error('Invalid data service response.');return{id:rpcUuid(q.id),position,prompt:rpcString(q.prompt),revealName:rpcString(q.revealName),mysteryMediaAssetId,revealMediaAssetId,mysteryMediaPreviewUrl,revealMediaPreviewUrl,funFact,choices};}):(()=>{throw new Error('Invalid data service response.');})();return{id:rpcUuid(row.id),name:rpcString(row.name),revision:rpcInteger(row.revision),createdAt:rpcString(row.createdAt),updatedAt:rpcString(row.updatedAt),questions};
}
export function parseGameList(value:unknown):ReadonlyArray<{id:string;name:string;revision:number;questionCount:number;createdAt:string;updatedAt:string}>{
  if(!Array.isArray(value))throw new Error('Invalid data service response.');return value.map(raw=>{const r=rpcObject(raw);return{id:rpcUuid(r.id),name:rpcString(r.name),revision:rpcInteger(r.revision),questionCount:rpcInteger(r.questionCount),createdAt:rpcString(r.createdAt),updatedAt:rpcString(r.updatedAt)};});
}

export interface RoomCreationLimitResponse {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}
export function parseRoomCreationLimit(value: unknown, expectedLimit = 5): RoomCreationLimitResponse {
  const row = rpcObject(value);
  if (typeof row.allowed !== 'boolean') throw new Error('Invalid data service response.');
  const limit = rpcInteger(row.limit);
  const remaining = rpcInteger(row.remaining);
  const retryAfterSeconds = rpcInteger(row.retryAfterSeconds);
  if (limit !== expectedLimit || remaining < 0 || remaining > limit || retryAfterSeconds < 0 || (row.allowed ? retryAfterSeconds !== 0 : retryAfterSeconds < 1)) {
    throw new Error('Invalid data service response.');
  }
  return { allowed: row.allowed, limit, remaining, retryAfterSeconds };
}

export function parseMediaByteLimit(value: unknown, expectedLimit=262144000): { readonly allowed: boolean; readonly limitBytes:number;readonly remainingBytes:number;readonly retryAfterSeconds: number } {
  const row=rpcObject(value);const limit=rpcInteger(row.limitBytes);const remaining=rpcInteger(row.remainingBytes);const retry=rpcInteger(row.retryAfterSeconds);
  if(typeof row.allowed!=='boolean'||limit!==expectedLimit||remaining<0||remaining>limit||retry<0||(row.allowed?retry!==0:retry<1))throw new Error('Invalid data service response.');
  return{allowed:row.allowed,limitBytes:limit,remainingBytes:remaining,retryAfterSeconds:retry};
}

export async function cleanupGameMedia(supabase: ReturnType<typeof adminClient>, adminHash: string): Promise<void> {
  try {
    const claimed = await supabase.rpc('claim_game_media_gc', { p_admin_token_hash: adminHash });
    if (claimed.error) throw claimed.error;
    if (!Array.isArray(claimed.data) || claimed.data.length > 20) throw new Error('Invalid media GC response.');
    const assets = claimed.data.map((raw) => {
      const row = rpcObject(raw);
      return { id:rpcUuid(row.id),storagePath:rpcString(row.storagePath),silhouetteStoragePath:rpcString(row.silhouetteStoragePath) };
    });
    if (assets.length > 0) {
      const removed = await supabase.storage.from('reveal-media').remove(assets.flatMap((asset) => [asset.storagePath,asset.silhouetteStoragePath]));
      if (!removed.error) {
        const finalized = await supabase.rpc('finalize_game_media_gc', { p_admin_token_hash: adminHash, p_media_ids: assets.map((asset) => asset.id) });
        if (finalized.error) throw finalized.error;
      } else {
        console.error('Media GC object removal will be retried.');
      }
    }

    // Reconcile legacy/interrupted objects that predate reservation-first
    // uploads. A two-hour age floor avoids deployment-crossing races.
    const inventory = await supabase.rpc('owner_game_media_paths', { p_admin_token_hash: adminHash });
    if (inventory.error) throw inventory.error;
    const inventoryRow = rpcObject(inventory.data);
    const ownerId = rpcUuid(inventoryRow.ownerId);
    if (!Array.isArray(inventoryRow.paths) || inventoryRow.paths.length > 1_000) throw new Error('Invalid media inventory response.');
    const tracked = new Set(inventoryRow.paths.map((path) => rpcString(path)));
    const prefix = `game-media/${ownerId}`;
    const listing = await supabase.storage.from('reveal-media').list(prefix, { limit: 1_000, offset: 0, sortBy: { column: 'name', order: 'asc' } });
    if (listing.error) throw listing.error;
    const cutoff = Date.now() - 2 * 60 * 60 * 1_000;
    const orphans = listing.data.filter((item) => {
      const created = Date.parse(item.created_at ?? '');
      return Number.isFinite(created) && created < cutoff && !tracked.has(`${prefix}/${item.name}`);
    }).slice(0, 100).map((item) => `${prefix}/${item.name}`);
    if (orphans.length > 0) {
      const removed = await supabase.storage.from('reveal-media').remove(orphans);
      if (removed.error) console.error('Untracked media reconciliation will be retried.');
    }
  } catch (error) {
    console.error('Media cleanup will be retried.', error instanceof Error ? error.message : 'unknown');
  }
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
  readonly eligibleFromRound: number;
}
export function parseJoinedParticipant(value: unknown): JoinedParticipantResponse {
  const row = rpcObject(value);
  const name = rpcString(row.displayName);
  if (name.trim() !== name || name.length < 1 || name.length > 40) throw new Error('Invalid data service response.');
  return {
    playerId: rpcUuid(row.playerId),
    roomId: rpcUuid(row.roomId),
    displayName: name,
    eligibleFromRound: (()=>{const n=row.eligibleFromRound===undefined?0:rpcInteger(row.eligibleFromRound);if(n<0||n>100)throw new Error('Invalid data service response.');return n;})(),
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
