import { adminClient, apiHandler, roomCode, throwRpcError } from '../../../_lib/api';

export const onRequest = apiHandler('GET', async ({ env, params }) => {
  const code = roomCode(params.code);
  const supabase = adminClient(env);
  const result = await supabase.rpc('silhouette_media_path', { p_code: code });
  if (result.error) throwRpcError(result.error);
  const row = result.data as { storagePath?: unknown; mimeType?: unknown };
  if (typeof row.storagePath !== 'string' || !['image/jpeg','image/png','image/webp'].includes(String(row.mimeType))) throw new Error('Invalid data service response.');
  const media = await supabase.storage.from('reveal-media').download(row.storagePath);
  if (media.error) throwRpcError(media.error);
  return new Response(media.data, { headers: { 'content-type': String(row.mimeType), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});
