import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodePng, generateSilhouette, safeImage } from './media';

const uploadRoute=readFileSync(new URL('../api/games/[id]/media/index.ts',import.meta.url),'utf8');

const file=(bytes:number[],type:string)=>new File([new Uint8Array(bytes)],'ignored.bin',{type});

describe('uploaded image validation',()=>{
  it('never trusts or stores a client-provided pre-reveal derivative',()=>{
    expect(uploadRoute).toContain('generateSilhouette(original)');
    expect(uploadRoute).not.toContain("form.get('silhouette')");
    expect(uploadRoute.indexOf("rpc('register_game_media'")).toBeLessThan(uploadRoute.indexOf("storage.from('reveal-media').upload"));
    expect(uploadRoute).toContain("rpc('complete_game_media'");
  });
  it('rejects spoofed and truncated signatures',async()=>{
    await expect(safeImage(file([0xff,0xd8,0xff,1,2,3],'image/jpeg'))).rejects.toMatchObject({code:'IMAGE_TYPE_MISMATCH'});
    await expect(safeImage(file([137,80,78,71,13,10,26,10],'image/png'))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
    await expect(safeImage(file([82,73,70,70,4,0,0,0,87,69,66,80],'image/webp'))).rejects.toMatchObject({code:'IMAGE_TYPE_MISMATCH'});
  });
  it('enforces the five MiB bound before parsing',async()=>{
    await expect(safeImage(new File([new Uint8Array(5*1024*1024+1)],'large.png',{type:'image/png'}))).rejects.toMatchObject({code:'IMAGE_TOO_LARGE'});
  });
  it('fully decodes a normalized RGBA PNG and generates a canonical low-information silhouette',async()=>{
    const rgba=new Uint8Array([
      10,20,30,255, 240,240,240,255,
      30,40,50,255, 250,250,250,255,
    ]);
    const bytes=await encodePng(2,2,rgba);
    const decoded=await safeImage(new File([bytes.slice().buffer],'normalized.png',{type:'image/png'}));
    expect([decoded.width,decoded.height]).toEqual([2,2]);
    expect(decoded.rgba).toEqual(rgba);
    const silhouette=await generateSilhouette(decoded);
    const result=await safeImage(new File([silhouette.slice().buffer],'silhouette.png',{type:'image/png'}));
    expect([result.width,result.height]).toEqual([180,225]);
    const colors=new Set<string>();
    for(let offset=0;offset<result.rgba.length;offset+=4) colors.add(`${result.rgba[offset]},${result.rgba[offset+1]},${result.rgba[offset+2]},${result.rgba[offset+3]}`);
    expect(colors.size).toBeLessThanOrEqual(2);
  });

  it('makes the public mystery image identical for adversarial visible and transparent source pixels',async()=>{
    const first={bytes:new Uint8Array(),width:2,height:1,rgba:new Uint8Array([0,0,0,255,255,255,255,255]),mimeType:'image/png' as const,extension:'png' as const};
    const second={bytes:new Uint8Array(),width:2,height:1,rgba:new Uint8Array([255,0,255,0,0,255,0,0]),mimeType:'image/png' as const,extension:'png' as const};
    expect(await generateSilhouette(first)).toEqual(await generateSilhouette(second));
  });

  it('rejects corrupt CRCs, missing image data, and trailing polyglot bytes',async()=>{
    const bytes=await encodePng(1,1,new Uint8Array([1,2,3,255]));
    const corrupt=bytes.slice();corrupt[corrupt.length-1]=(corrupt.at(-1)??0)^1;
    await expect(safeImage(new File([corrupt],'bad.png',{type:'image/png'}))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
    const trailing=new Uint8Array(bytes.length+3);trailing.set(bytes);trailing.set([1,2,3],bytes.length);
    await expect(safeImage(new File([trailing],'polyglot.png',{type:'image/png'}))).rejects.toMatchObject({code:'UNSAFE_IMAGE_TYPE'});
  });
});
