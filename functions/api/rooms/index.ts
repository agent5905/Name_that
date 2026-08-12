import {
  adminClient, apiHandler, json, newRoomCode, newToken, parseCleanupRealtimeAuth, parseCleanupRooms,
  parseCreatedRoom, parseRoomCreationLimit, roomCreationSourceHash, throwRpcError, tokenHash,
} from '../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, request }) => {
  const supabase = adminClient(env);
  const limitResult = await supabase.rpc('consume_room_creation_attempt', {
    p_source_hash: await roomCreationSourceHash(request),
  });
  if (limitResult.error) throwRpcError(limitResult.error);
  const limit = parseRoomCreationLimit(limitResult.data);
  if (!limit.allowed) {
    return json({ error: {
      code: 'ROOM_CREATION_RATE_LIMITED',
      message: 'Too many rooms were created from this source. Try again later.',
    } }, 429, { 'retry-after': String(limit.retryAfterSeconds) });
  }

  const cleanupResult = await supabase.rpc('cleanup_expired_rooms');
  if (cleanupResult.error) throwRpcError(cleanupResult.error);
  parseCleanupRooms(cleanupResult.data);
  const authCleanupResult = await supabase.rpc('cleanup_stale_realtime_auth_users');
  if (authCleanupResult.error) throwRpcError(authCleanupResult.error);
  parseCleanupRealtimeAuth(authCleanupResult.data);

  const hostToken = newToken();
  const hostTokenHash = await tokenHash(hostToken);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newRoomCode();
    const { data, error } = await supabase.rpc('create_room', { p_code: code, p_host_token_hash: hostTokenHash });
    if (!error) return json({ room: parseCreatedRoom(data), hostToken }, 201);
    if (!error.message.includes('CODE_COLLISION')) throwRpcError(error);
  }
  throw new Error('Room code retry budget exhausted.');
});
