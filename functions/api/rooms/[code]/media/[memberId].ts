import { adminClient, apiHandler, json, roomCode, throwRpcError, uuid } from '../../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params }) => {
  const code = roomCode(params.code);
  const memberId = uuid(params.memberId, 'Member ID');
  const supabase = adminClient(env);
  const pathResult = await supabase.rpc('reveal_media_path', { p_code: code, p_member_id: memberId });
  if (pathResult.error) throwRpcError(pathResult.error);
  if (typeof pathResult.data !== 'string') return json({ error: { code: 'MEDIA_NOT_AVAILABLE', message: 'Media is not available.' } }, 404);
  const media = await supabase.storage.from('reveal-media').download(pathResult.data);
  if (media.error) throwRpcError(media.error);
  return new Response(media.data, {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
