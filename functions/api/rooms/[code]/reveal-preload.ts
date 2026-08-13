import { adminClient,apiHandler,parsePreloadLocation,preloadCacheKey,preloadQuery,roomCode,throwRpcError } from '../../../_lib/api';
import { encryptRevealWithKey } from '../../../_lib/media';

function withCacheStatus(response:Response,status:'HIT'|'MISS'):Response{
  const headers=new Headers(response.headers);
  headers.set('x-name-that-cache',status);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export const onRequest=apiHandler('GET',async({env,params,request,waitUntil})=>{
  const code=roomCode(params.code);
  const{round,asset}=preloadQuery(request);
  const cacheKey=preloadCacheKey(request,code,'reveal',round,asset);
  const cache=await caches.open('preload-assets');
  const hit=await cache.match(cacheKey);
  if(hit)return withCacheStatus(hit,'HIT');
  const supabase=adminClient(env);
  const result=await supabase.rpc('room_preload_media',{p_code:code,p_round:round,p_asset_id:asset,p_kind:'reveal'});
  if(result.error)throwRpcError(result.error);
  const location=parsePreloadLocation(result.data,'reveal');
  const media=await supabase.storage.from('reveal-media').download(location.storagePath);
  if(media.error)throwRpcError(media.error);
  if(!location.key||!location.iv||!location.aad)throw new Error('Invalid data service response.');
  const ciphertext=await encryptRevealWithKey(new Uint8Array(await media.data.arrayBuffer()),location.key,location.iv,location.aad);
  const response=new Response(ciphertext.slice().buffer,{headers:{'content-type':'application/octet-stream','content-length':String(ciphertext.byteLength),'cache-control':'public, max-age=3600, s-maxage=86400, immutable','x-preload-key':`${code}:${location.roundIndex}:reveal`,'x-content-type-options':'nosniff'}});
  waitUntil(cache.put(cacheKey,response.clone()));
  return withCacheStatus(response,'MISS');
});
