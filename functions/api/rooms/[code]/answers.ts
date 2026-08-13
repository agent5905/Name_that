import { ApiError, adminClient, apiHandler, bearerToken, expectedRound, json, parseSubmittedAnswer, readJson, roomCode, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export function answerRequest(body:Record<string,unknown>):{playerId:string;choiceId:string;roundIndex:number}{
  const keys=Object.keys(body).sort();
  if(keys.length!==3||keys[0]!=='choiceId'||keys[1]!=='playerId'||keys[2]!=='roundIndex'){
    throw new ApiError(400,'INVALID_ANSWER','Answer request contains unsupported fields.');
  }
  return{playerId:uuid(body.playerId,'Player ID'),choiceId:uuid(body.choiceId,'Choice ID'),roundIndex:expectedRound(body.roundIndex)};
}

export const onRequest = apiHandler('POST', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const body = answerRequest(await readJson(request));
  const { data, error } = await adminClient(env).rpc('submit_answer', {
    p_code: code,
    p_player_id: body.playerId,
    p_participant_token_hash: await tokenHash(bearerToken(request)),
    p_employee_id: body.choiceId,
    p_expected_round: body.roundIndex,
  });
  if (error) throwRpcError(error);
  return json({ answer: parseSubmittedAnswer(data) });
});
