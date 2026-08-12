import { adminClient, ApiError, bearerToken, json, throwRpcError, tokenHash, uuid, type Env } from '../../../../_lib/api';

export const onRequest: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    if (request.method !== 'GET') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405);
    const gameId = uuid(params.id, 'Game ID');
    const mediaId = uuid(params.assetId, 'Media ID');
    const supabase = adminClient(env);
    const result = await supabase.rpc('get_game_media', {
      p_admin_token_hash: await tokenHash(bearerToken(request)), p_game_id: gameId, p_media_id: mediaId,
    });
    if (result.error) throwRpcError(result.error);
    const row = result.data as { storagePath?: unknown; mimeType?: unknown };
    if (typeof row.storagePath !== 'string' || !['image/jpeg','image/png','image/webp'].includes(String(row.mimeType))) throw new Error('Invalid data service response.');
    const media = await supabase.storage.from('reveal-media').download(row.storagePath);
    if (media.error) throwRpcError(media.error);
    return new Response(media.data, { headers: { 'content-type': String(row.mimeType), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error('Unhandled API error', error instanceof Error ? error.message : 'unknown');
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
  }
};
