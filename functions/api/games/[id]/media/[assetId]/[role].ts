import { adminClient,apiHandler,bearerToken,parseMediaLocation,roomMediaRole,throwRpcError,tokenHash,uuid } from '../../../../../_lib/api';

export const onRequest=apiHandler('GET',async({env,params,request})=>{
 const gameId=uuid(params.id,'Game ID');const mediaId=uuid(params.assetId,'Media ID');const role=roomMediaRole(params.role);
 const supabase=adminClient(env);const result=await supabase.rpc('get_game_media_role',{p_admin_token_hash:await tokenHash(bearerToken(request)),p_game_id:gameId,p_media_id:mediaId,p_role:role});
 if(result.error)throwRpcError(result.error);const location=parseMediaLocation(result.data);const media=await supabase.storage.from('reveal-media').download(location.storagePath);if(media.error)throwRpcError(media.error);
 return new Response(media.data,{headers:{'content-type':location.mimeType,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
});
