import { adminClient, ApiError, bearerToken, cleanupGameMedia, json, parseGameDefinition, readJson, roomCreationSourceHash, throwRpcError, tokenHash, uuid, type Env } from '../../../_lib/api';
import { definition } from '../index';

export const onRequest: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    const gameId = uuid(params.id, 'Game ID');
    const hash = await tokenHash(bearerToken(request));
    const supabase = adminClient(env);
    if (request.method === 'GET') {
      const result = await supabase.rpc('get_game_definition', { p_admin_token_hash: hash, p_game_id: gameId });
      if (result.error) throwRpcError(result.error);
      return json({ game: parseGameDefinition(result.data) });
    }
    if (request.method === 'PUT') {
      const body = await readJson(request, 262_144);
      if (!Number.isInteger(body.revision)) {
        throw new ApiError(422, 'INVALID_GAME', 'Name, revision, and questions are required.');
      }
      const value=definition(body);
      const result = await supabase.rpc('update_game_definition', {
        p_admin_token_hash: hash,p_source_hash:await roomCreationSourceHash(request), p_game_id: gameId, p_revision: body.revision as number,
        p_name: value.name, p_questions: value.questions as never,
      });
      if (result.error) throwRpcError(result.error);
      return json({ game: parseGameDefinition(result.data) });
    }
    if (request.method === 'DELETE') {
      const result = await supabase.rpc('delete_game_definition', { p_admin_token_hash: hash,p_source_hash:await roomCreationSourceHash(request), p_game_id: gameId });
      if (result.error) throwRpcError(result.error);
      const paths = (result.data as { storagePaths?: unknown }).storagePaths;
      if (Array.isArray(paths) && paths.every((path) => typeof path === 'string') && paths.length > 0) {
        const removal = await supabase.storage.from('reveal-media').remove(paths);
        if (removal.error) console.error('Deleted game but media cleanup will need retry.');
      }
      await cleanupGameMedia(supabase, hash);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET, PUT, or DELETE.' } }, 405);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error('Unhandled API error', error instanceof Error ? error.message : 'unknown');
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
  }
};
