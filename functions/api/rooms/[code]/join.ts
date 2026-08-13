import { adminClient, apiHandler, displayName, json, opaqueToken, parseJoinedParticipant, readJson, roomCode, throwRpcError, tokenHash, uuid } from '../../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const body = await readJson(request);
  const name = displayName(body.name);
  const participantToken = opaqueToken(body.participantToken);
  const joinOperationId = uuid(body.idempotencyKey, 'Idempotency key');
  const { data, error } = await adminClient(env).rpc('join_room', {
    p_code: code,
    p_display_name: name,
    p_participant_token_hash: await tokenHash(participantToken),
    p_join_operation_id: joinOperationId,
  });
  if (error) throwRpcError(error);
  return json({ participant: parseJoinedParticipant(data), participantToken }, 201);
});
