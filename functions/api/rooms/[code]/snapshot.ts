import { adminClient, apiHandler, bearerToken, json, normalizeSnapshot, parseParticipantRoomSnapshot, roomCode, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const supabase = adminClient(env);
  const playerHeader = request.headers.get('x-player-id');
  const authHeader = request.headers.get('authorization');
  if (playerHeader || authHeader) {
    const playerId = uuid(playerHeader, 'Player ID');
    const token = bearerToken(request);
    const answer = await supabase.rpc('participant_room_snapshot', {
      p_code: code,
      p_player_id: playerId,
      p_participant_token_hash: await tokenHash(token),
    });
    if (answer.error) throwRpcError(answer.error);
    const projection=parseParticipantRoomSnapshot(answer.data);
    return json({snapshot:normalizeSnapshot(projection.snapshot),participant:{playerId,...projection.participant}});
  }
  const { data, error } = await supabase.from('room_snapshots').select('*').eq('room_code', code).maybeSingle();
  if (error) throwRpcError(error);
  if (!data) return json({ error: { code: 'ROOM_NOT_FOUND', message: 'Room was not found.' } }, 404);
  return json({ snapshot: normalizeSnapshot(data) });
});
