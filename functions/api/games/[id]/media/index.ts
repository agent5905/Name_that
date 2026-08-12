import { adminClient, ApiError, bearerToken, cleanupGameMedia, json, parseMedia, parseMediaByteLimit, parseRoomCreationLimit, roomCreationSourceHash, throwRpcError, tokenHash, uuid, type Env } from '../../../../_lib/api';
import { boundedMultipart, generateSilhouette, safeImage } from '../../../../_lib/media';

export const onRequest: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405);
    const gameId = uuid(params.id, 'Game ID');
    const hash = await tokenHash(bearerToken(request));
    const supabase = adminClient(env);
    const existing = await supabase.rpc('get_game_definition', { p_admin_token_hash: hash, p_game_id: gameId });
    if (existing.error) throwRpcError(existing.error);
    const sourceHash = await roomCreationSourceHash(request);
    const sourceAdmission = await supabase.rpc('consume_media_source_attempt', { p_source_hash: sourceHash });
    if (sourceAdmission.error) throwRpcError(sourceAdmission.error);
    const sourceGate = parseRoomCreationLimit(sourceAdmission.data, 30);
    if (!sourceGate.allowed) return json({ error: { code: 'MEDIA_UPLOAD_RATE_LIMITED', message: 'Too many images were uploaded from this network. Try again later.' } }, 429, { 'retry-after': String(sourceGate.retryAfterSeconds) });
    const admission = await supabase.rpc('consume_media_upload_attempt', { p_admin_token_hash: hash });
    if (admission.error) throwRpcError(admission.error);
    const gate = parseRoomCreationLimit(admission.data, 100);
    if (!gate.allowed) return json({ error: { code: 'MEDIA_UPLOAD_RATE_LIMITED', message: 'Too many images were uploaded. Try again later.' } }, 429, { 'retry-after': String(gate.retryAfterSeconds) });
    await cleanupGameMedia(supabase, hash);
    const form = await boundedMultipart(request);
    const original = await safeImage(form.get('file'));
    const silhouetteBytes = await generateSilhouette(original);
    const byteAdmission = await supabase.rpc('reserve_media_source_bytes', { p_source_hash: sourceHash, p_byte_size: original.bytes.byteLength });
    if (byteAdmission.error) throwRpcError(byteAdmission.error);
    const byteGate = parseMediaByteLimit(byteAdmission.data);
    if (!byteGate.allowed) return json({ error: { code: 'MEDIA_UPLOAD_BYTE_LIMITED', message: 'This network has reached its daily image allowance.' } }, 429, { 'retry-after': String(byteGate.retryAfterSeconds) });
    const owner = await supabase.rpc('admin_owner_id', { p_admin_token_hash: hash });
    if (owner.error) throwRpcError(owner.error);
    const ownerId = uuid(owner.data, 'Owner ID');
    // Authorization of the game is repeated by register_game_media. Random,
    // filename-free paths prevent traversal and disclosure of local filenames.
    const assetKey = crypto.randomUUID();
    const path = `game-media/${ownerId}/${assetKey}.${original.extension}`;
    const silhouettePath = `game-media/${ownerId}/${assetKey}-silhouette.png`;
    const reserved = await supabase.rpc('register_game_media', {
      p_admin_token_hash: hash, p_game_id: gameId, p_storage_path: path,
      p_silhouette_storage_path: silhouettePath, p_mime_type: original.mimeType,
      p_silhouette_mime_type: 'image/png', p_byte_size: original.bytes.byteLength,
    });
    if (reserved.error) throwRpcError(reserved.error);
    const media = parseMedia(reserved.data);
    const first = await supabase.storage.from('reveal-media').upload(path, original.bytes, { contentType: original.mimeType, upsert: false });
    if (first.error) throwRpcError(first.error);
    const second = await supabase.storage.from('reveal-media').upload(silhouettePath, silhouetteBytes, { contentType: 'image/png', upsert: false });
    if (second.error) { await supabase.storage.from('reveal-media').remove([path]); throwRpcError(second.error); }
    const completed = await supabase.rpc('complete_game_media', { p_admin_token_hash: hash, p_game_id: gameId, p_media_id: media.id });
    if (completed.error) throwRpcError(completed.error);
    return json({ media: parseMedia(completed.data) }, 201);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error('Unhandled API error', error instanceof Error ? error.message : 'unknown');
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
  }
};
