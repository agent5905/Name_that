import { adminClient, apiHandler, bearerToken, json, parseHostRoom, roomCode, throwRpcError, tokenHash } from '../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const { data, error } = await adminClient(env).rpc('host_room', {
    p_code: code,
    p_host_token_hash: await tokenHash(bearerToken(request)),
  });
  if (error) throwRpcError(error);
  return json({ host: parseHostRoom(data) });
});
