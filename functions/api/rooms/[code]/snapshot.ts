import { adminClient, apiHandler, bearerToken, json, normalizeSnapshot, roomCode, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const supabase = adminClient(env);
  const { data, error } = await supabase.from('room_snapshots').select('*').eq('room_code', code).maybeSingle();
  if (error) throwRpcError(error);
  if (!data) return json({ error: { code: 'ROOM_NOT_FOUND', message: 'Room was not found.' } }, 404);

  const playerHeader = request.headers.get('x-player-id');
  const authHeader = request.headers.get('authorization');
  let participant: Record<string, unknown> | undefined;
  if (playerHeader || authHeader) {
    const playerId = uuid(playerHeader, 'Player ID');
    const token = bearerToken(request);
    const answer = await supabase.rpc('participant_answer', {
      p_code: code,
      p_player_id: playerId,
      p_participant_token_hash: await tokenHash(token),
    });
    if (answer.error) throwRpcError(answer.error);
    const answerData = typeof answer.data === 'object' && answer.data !== null && !Array.isArray(answer.data) ? answer.data : {};
    participant = { playerId, answerEmployeeId: answerData.employeeId ?? null };
  }
  return json({ snapshot: normalizeSnapshot(data), ...(participant ? { participant } : {}) });
});
