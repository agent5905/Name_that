import { adminClient, apiHandler, bearerToken, json, parseSubmittedAnswer, readJson, roomCode, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const body = await readJson(request);
  const { data, error } = await adminClient(env).rpc('submit_answer', {
    p_code: code,
    p_player_id: uuid(body.playerId, 'Player ID'),
    p_participant_token_hash: await tokenHash(bearerToken(request)),
    p_employee_id: uuid(body.choiceId, 'Choice ID'),
  });
  if (error) throwRpcError(error);
  return json({ answer: parseSubmittedAnswer(data) });
});
