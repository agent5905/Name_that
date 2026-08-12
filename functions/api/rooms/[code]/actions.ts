import { adminClient, apiHandler, bearerToken, json, normalizeSnapshot, readJson, requireAction, roomCode, throwRpcError, tokenHash } from '../../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, params, request }) => {
  const code = roomCode(params.code);
  const body = await readJson(request);
  const { data, error } = await adminClient(env).rpc('host_action', {
    p_code: code,
    p_host_token_hash: await tokenHash(bearerToken(request)),
    p_action: requireAction(body.action),
  });
  if (error) throwRpcError(error);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Invalid snapshot response.');
  return json({ snapshot: normalizeSnapshot(data) });
});
