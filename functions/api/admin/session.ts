import {
  adminClient, apiHandler, json, newToken, parseRoomCreationLimit,
  parseAdmin, roomCreationSourceHash, throwRpcError, tokenHash,
} from '../../_lib/api';

export const onRequest = apiHandler('POST', async ({ env, request }) => {
  const supabase = adminClient(env);
  const limited = await supabase.rpc('consume_admin_profile_attempt', {
    p_source_hash: await roomCreationSourceHash(request),
  });
  if (limited.error) throwRpcError(limited.error);
  const gate = parseRoomCreationLimit(limited.data);
  if (!gate.allowed) return json({ error: {
    code: 'ADMIN_SESSION_RATE_LIMITED', message: 'Too many admin profiles were created. Try again later.',
  } }, 429, { 'retry-after': String(gate.retryAfterSeconds) });
  const cleanup=await supabase.rpc('cleanup_stale_studio_state');
  if(cleanup.error)throwRpcError(cleanup.error);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adminToken = newToken();
    const result = await supabase.rpc('create_admin_profile', { p_admin_token_hash: await tokenHash(adminToken) });
    if (!result.error) {
      return json({ admin: parseAdmin(result.data), adminToken }, 201);
    }
    if (!result.error.message.includes('TOKEN_COLLISION')) throwRpcError(result.error);
  }
  throw new Error('Admin token retry budget exhausted.');
});
