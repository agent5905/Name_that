import { adminClient, apiHandler, parseMediaLocation, roomCode, throwRpcError, uuid } from '../../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params }) => {
  const code = roomCode(params.code);
  const memberId = uuid(params.memberId, 'Member ID');
  const supabase = adminClient(env);
  const pathResult = await supabase.rpc('reveal_media_path', { p_code: code, p_member_id: memberId });
  if (pathResult.error) throwRpcError(pathResult.error);
  const location=parseMediaLocation(pathResult.data);
  const media = await supabase.storage.from('reveal-media').download(location.storagePath);
  if (media.error) throwRpcError(media.error);
  return new Response(media.data, {
    status: 200,
    headers: {
      'content-type': location.mimeType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
