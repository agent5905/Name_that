import { adminClient, ApiError, bearerToken, cleanupGameMedia, json, parseMediaPair, parseRoomCreationLimit, roomCreationSourceHash, throwRpcError, tokenHash, uuid, type Env } from '../../../../_lib/api';
import { boundedMultipart, safeImage } from '../../../../_lib/media';

export const onRequest: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    if(request.method!=='POST')return json({error:{code:'METHOD_NOT_ALLOWED',message:'Use POST.'}},405);
    const gameId=uuid(params.id,'Game ID');const hash=await tokenHash(bearerToken(request));const supabase=adminClient(env);
    const existing=await supabase.rpc('get_game_definition',{p_admin_token_hash:hash,p_game_id:gameId});if(existing.error)throwRpcError(existing.error);
    const sourceHash=await roomCreationSourceHash(request);
    const sourceAdmission=await supabase.rpc('consume_media_source_attempt',{p_source_hash:sourceHash});if(sourceAdmission.error)throwRpcError(sourceAdmission.error);
    const sourceGate=parseRoomCreationLimit(sourceAdmission.data,30);if(!sourceGate.allowed)return json({error:{code:'MEDIA_UPLOAD_RATE_LIMITED',message:'Too many images were uploaded from this network. Try again later.'}},429,{'retry-after':String(sourceGate.retryAfterSeconds)});
    const admission=await supabase.rpc('consume_media_upload_attempt',{p_admin_token_hash:hash});if(admission.error)throwRpcError(admission.error);
    const gate=parseRoomCreationLimit(admission.data,100);if(!gate.allowed)return json({error:{code:'MEDIA_UPLOAD_RATE_LIMITED',message:'Too many images were uploaded. Try again later.'}},429,{'retry-after':String(gate.retryAfterSeconds)});
    await cleanupGameMedia(supabase,hash);
    const form=await boundedMultipart(request);const mystery=await safeImage(form.get('mystery'));const reveal=await safeImage(form.get('reveal'));
    const assetKey=crypto.randomUUID();
    const owner=await supabase.rpc('admin_owner_id',{p_admin_token_hash:hash});if(owner.error)throwRpcError(owner.error);const ownerId=uuid(owner.data,'Owner ID');
    const mysteryPath=`game-media/${ownerId}/${assetKey}-mystery.png`;const revealPath=`game-media/${ownerId}/${assetKey}-reveal.png`;
    const reserved=await supabase.rpc('register_game_media_pair',{p_admin_token_hash:hash,p_source_hash:sourceHash,p_game_id:gameId,p_mystery_path:mysteryPath,p_reveal_path:revealPath,
      p_mystery_mime:'image/png',p_reveal_mime:'image/png',p_mystery_bytes:mystery.bytes.byteLength,p_reveal_bytes:reveal.bytes.byteLength});
    if(reserved.error)throwRpcError(reserved.error);const pair=parseMediaPair(reserved.data);const uploaded:string[]=[];
    try{
      for(const [path,bytes,type]of [[mysteryPath,mystery.bytes,'image/png'],[revealPath,reveal.bytes,'image/png']]as const){
        const result=await supabase.storage.from('reveal-media').upload(path,bytes,{contentType:type,upsert:false});if(result.error)throwRpcError(result.error);uploaded.push(path);
      }
      const completed=await supabase.rpc('complete_game_media_pair',{p_admin_token_hash:hash,p_game_id:gameId,p_media_id:pair.id});if(completed.error)throwRpcError(completed.error);
      return json({media:parseMediaPair(completed.data)},201);
    }catch(error){if(uploaded.length)await supabase.storage.from('reveal-media').remove(uploaded);throw error;}
  }catch(error){
    if(error instanceof ApiError)return json({error:{code:error.code,message:error.message}},error.status);
    console.error('Unhandled API error',error instanceof Error?error.message:'unknown');return json({error:{code:'INTERNAL_ERROR',message:'The request could not be completed.'}},500);
  }
};
