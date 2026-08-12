import { adminClient, ApiError, bearerToken, json, parseGameDefinition, parseGameList, readJson, roomCreationSourceHash, throwRpcError, tokenHash, type Env } from '../../_lib/api';

interface QuestionInput { readonly prompt: string; readonly revealName: string; readonly mediaAssetId: string | null; readonly choices: ReadonlyArray<{ text: string; isCorrect: boolean }> }

export function definition(body: Record<string, unknown>): { name: string; questions: QuestionInput[] } {
  if (typeof body.name !== 'string' || !Array.isArray(body.questions)) {
    throw new ApiError(422, 'INVALID_GAME', 'Name and questions are required.');
  }
  const questions=body.questions.map((raw)=>{if(typeof raw!=='object'||raw===null||Array.isArray(raw))throw new ApiError(422,'INVALID_GAME','A question is invalid.');const q=raw as Record<string,unknown>;if(typeof q.prompt!=='string'||typeof q.revealName!=='string'||!Array.isArray(q.choices))throw new ApiError(422,'INVALID_GAME','A question is invalid.');const choices=q.choices.map(rawChoice=>{if(typeof rawChoice!=='object'||rawChoice===null||Array.isArray(rawChoice))throw new ApiError(422,'INVALID_GAME','A choice is invalid.');const c=rawChoice as Record<string,unknown>;if(typeof c.text!=='string'||typeof c.isCorrect!=='boolean')throw new ApiError(422,'INVALID_GAME','A choice is invalid.');return{text:c.text,isCorrect:c.isCorrect};});return{prompt:q.prompt,revealName:q.revealName,mediaAssetId:typeof q.mediaAssetId==='string'?q.mediaAssetId:null,choices};});
  return { name: body.name, questions };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    const request = context.request;
    const token = bearerToken(request);
    const supabase = adminClient(context.env);
    if (request.method === 'GET') {
      const result = await supabase.rpc('list_game_definitions', { p_admin_token_hash: await tokenHash(token) });
      if (result.error) throwRpcError(result.error);
      return json({ games: parseGameList(result.data) });
    }
    if (request.method === 'POST') {
      const hash=await tokenHash(token);
      let value;
      try { value = definition(await readJson(request, 262_144)); }
      catch { return json({ error: { code: 'INVALID_GAME', message: 'Name and questions are required.' } }, 422); }
      const result = await supabase.rpc('create_game_definition', {
        p_admin_token_hash: hash,p_source_hash:await roomCreationSourceHash(request), p_name: value.name, p_questions: value.questions as never,
      });
      if (result.error) throwRpcError(result.error);
      return json({ game: parseGameDefinition(result.data) }, 201);
    }
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } }, 405);
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      const e = error as Error & { status: number; code: string };
      return json({ error: { code: e.code, message: e.message } }, e.status);
    }
    console.error('Unhandled API error', error instanceof Error ? error.message : 'unknown');
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
  }
};
