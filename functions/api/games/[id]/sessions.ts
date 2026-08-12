import { adminClient, apiHandler, bearerToken, json, newRoomCode, opaqueToken, parseCleanupRealtimeAuth, parseCleanupRooms, parseRoomCreationLimit, parseSavedSession, readJson, roomCreationSourceHash, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, params, request }) => {
  const gameId = uuid(params.id, 'Game ID');
  const adminHash = await tokenHash(bearerToken(request));
  const supabase = adminClient(env);
  const authorized=await supabase.rpc('get_game_definition',{p_admin_token_hash:adminHash,p_game_id:gameId});
  if(authorized.error)throwRpcError(authorized.error);
  const admission=await supabase.rpc('consume_saved_session_attempt',{p_source_hash:await roomCreationSourceHash(request)});
  if(admission.error)throwRpcError(admission.error);
  const gate=parseRoomCreationLimit(admission.data,20);
  if(!gate.allowed)return json({error:{code:'SESSION_CREATION_RATE_LIMITED',message:'Too many sessions were created. Try again later.'}},429,{'retry-after':String(gate.retryAfterSeconds)});
  const cleanup=await supabase.rpc('cleanup_expired_rooms');if(cleanup.error)throwRpcError(cleanup.error);parseCleanupRooms(cleanup.data);
  const authCleanup=await supabase.rpc('cleanup_stale_realtime_auth_users');if(authCleanup.error)throwRpcError(authCleanup.error);parseCleanupRealtimeAuth(authCleanup.data);
  const body = await readJson(request);
  const hostToken = opaqueToken(body.hostToken);
  const key = uuid(body.idempotencyKey,'Idempotency key');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newRoomCode();
    const result = await supabase.rpc('create_game_session', {
      p_admin_token_hash: adminHash, p_game_id: gameId, p_code: code,
      p_host_token_hash: await tokenHash(hostToken), p_idempotency_key: key,
    });
    if (!result.error) return json({ room: parseSavedSession(result.data), hostToken }, 201);
    if (!result.error.message.includes('CODE_COLLISION')) throwRpcError(result.error);
  }
  throw new Error('Room code retry budget exhausted.');
});
