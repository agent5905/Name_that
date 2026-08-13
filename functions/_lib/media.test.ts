import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodePng, encryptRevealWithKey, safeImage } from './media';

const uploadRoute=readFileSync(new URL('../api/games/[id]/media/index.ts',import.meta.url),'utf8');
const mysteryPreloadRoute=readFileSync(new URL('../api/rooms/[code]/mystery-preload.ts',import.meta.url),'utf8');
const revealPreloadRoute=readFileSync(new URL('../api/rooms/[code]/reveal-preload.ts',import.meta.url),'utf8');
const revealKeyRoute=readFileSync(new URL('../api/rooms/[code]/reveal-key/[choiceId].ts',import.meta.url),'utf8');

const file=(bytes:number[],type:string)=>new File([new Uint8Array(bytes)],'ignored.bin',{type});

describe('uploaded image validation',()=>{
  it('requires two explicit host images and reserves the atomic pair before both objects',()=>{
    expect(uploadRoute).toContain("safeImage(form.get('mystery'))");
    expect(uploadRoute).toContain("safeImage(form.get('reveal'))");
    expect(uploadRoute).not.toContain('generateSilhouette');
    expect(uploadRoute.indexOf("rpc('register_game_media_pair'")).toBeLessThan(uploadRoute.indexOf("storage.from('reveal-media').upload"));
    expect(uploadRoute).toContain("rpc('complete_game_media_pair'");
    expect(uploadRoute).not.toContain('encryptedPath');
    expect(uploadRoute).toContain("if(uploaded.length)await supabase.storage.from('reveal-media').remove(uploaded)");
  });

  it('uses session-scoped AES-GCM material so one room key cannot decrypt another room preload',async()=>{
    const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
    const plaintext=new Uint8Array([1,2,3,4,5]);
    const roomA={key:new Uint8Array(32).fill(1),iv:new Uint8Array(12).fill(2),aad:'name-that:room-a:question-a'};
    const roomB={key:new Uint8Array(32).fill(3),iv:new Uint8Array(12).fill(4),aad:'name-that:room-b:question-b'};
    const ciphertextA=await encryptRevealWithKey(plaintext,encode(roomA.key),encode(roomA.iv),roomA.aad);
    const ciphertextB=await encryptRevealWithKey(plaintext,encode(roomB.key),encode(roomB.iv),roomB.aad);
    expect(ciphertextA).not.toEqual(plaintext);expect(ciphertextB).not.toEqual(ciphertextA);
    const learnedRoomAKey=await crypto.subtle.importKey('raw',roomA.key.slice().buffer,{name:'AES-GCM'},false,['decrypt']);
    await expect(crypto.subtle.decrypt({name:'AES-GCM',iv:roomB.iv.slice().buffer,additionalData:new TextEncoder().encode(roomB.aad)},learnedRoomAKey,ciphertextB.slice().buffer)).rejects.toBeInstanceOf(Error);
    const roomBKey=await crypto.subtle.importKey('raw',roomB.key.slice().buffer,{name:'AES-GCM'},false,['decrypt']);
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:roomB.iv.slice().buffer,additionalData:new TextEncoder().encode(roomB.aad)},roomBKey,ciphertextB.slice().buffer);
    expect(new Uint8Array(clear)).toEqual(plaintext);
  });

  it('dynamically serves only cacheable ciphertext before reveal and delegates key release to the phase-gated RPC',()=>{
    expect(revealPreloadRoute).toContain("p_kind:'reveal'");expect(revealPreloadRoute).toContain('p_asset_id:asset');expect(revealPreloadRoute).toContain("'content-type':'application/octet-stream'");expect(revealPreloadRoute).toContain("'cache-control':'public, max-age=3600, s-maxage=86400, immutable'");
    expect(revealPreloadRoute).toContain("caches.open('preload-assets')");expect(revealPreloadRoute).toContain('cache.match(cacheKey)');expect(revealPreloadRoute).toContain("withCacheStatus(hit,'HIT')");expect(revealPreloadRoute).toContain('waitUntil(cache.put(cacheKey,response.clone()))');expect(revealPreloadRoute).toContain("withCacheStatus(response,'MISS')");
    expect(revealPreloadRoute).toContain('encryptRevealWithKey');expect(revealKeyRoute).toContain("rpc('reveal_preload_key'");expect(revealKeyRoute).toContain("'cache-control':'private, no-store'");
  });
  it('uses canonical Cache API keys with observable misses and hits for both safe preload kinds',()=>{
    for(const route of [mysteryPreloadRoute,revealPreloadRoute]){
      expect(route).toContain('preloadCacheKey(request,code');
      expect(route).toContain("withCacheStatus(hit,'HIT')");
      expect(route).toContain('waitUntil(cache.put(cacheKey,response.clone()))');
      expect(route).toContain("withCacheStatus(response,'MISS')");
      expect(route).toContain("headers.set('x-name-that-cache',status)");
    }
  });
  it('rejects spoofed and truncated signatures',async()=>{
    await expect(safeImage(file([0xff,0xd8,0xff,1,2,3],'image/jpeg'))).rejects.toMatchObject({code:'IMAGE_TYPE_MISMATCH'});
    await expect(safeImage(file([137,80,78,71,13,10,26,10],'image/png'))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
    await expect(safeImage(file([82,73,70,70,4,0,0,0,87,69,66,80],'image/webp'))).rejects.toMatchObject({code:'IMAGE_TYPE_MISMATCH'});
  });
  it('enforces the five MiB bound before parsing',async()=>{
    await expect(safeImage(new File([new Uint8Array(5*1024*1024+1)],'large.png',{type:'image/png'}))).rejects.toMatchObject({code:'IMAGE_TOO_LARGE'});
  });
  it('fully decodes and canonicalizes a normalized RGBA PNG',async()=>{
    const rgba=new Uint8Array([
      10,20,30,255, 240,240,240,255,
      30,40,50,255, 250,250,250,255,
    ]);
    const bytes=await encodePng(2,2,rgba);
    const decoded=await safeImage(new File([bytes.slice().buffer],'normalized.png',{type:'image/png'}));
    expect([decoded.width,decoded.height]).toEqual([2,2]);
    expect(decoded.bytes).toEqual(bytes);
    expect(decoded.bytes).toEqual(bytes);
  });

  it('rejects corrupt CRCs, missing image data, and trailing polyglot bytes',async()=>{
    const bytes=await encodePng(1,1,new Uint8Array([1,2,3,255]));
    const corrupt=bytes.slice();corrupt[corrupt.length-1]=(corrupt.at(-1)??0)^1;
    await expect(safeImage(new File([corrupt],'bad.png',{type:'image/png'}))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
    const trailing=new Uint8Array(bytes.length+3);trailing.set(bytes);trailing.set([1,2,3],bytes.length);
    await expect(safeImage(new File([trailing],'polyglot.png',{type:'image/png'}))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
  });
});
