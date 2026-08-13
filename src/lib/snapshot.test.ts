import { describe, expect, it } from 'vitest';
import { mergeCountOnlySnapshot, parsePushedSnapshot, preserveRevealEnrichment, shouldReplaceSnapshot } from './snapshot';

const id='11111111-1111-4111-8111-111111111111';
const base={roomCode:'F7K2M',phase:'employee_revealed',roundIndex:0,roundCount:2,connectedParticipantCount:2,eligibleParticipantCount:2,submittedAnswerCount:2,version:8,choices:[{id,displayName:'Alex',position:0},{id:'22222222-2222-4222-8222-222222222222',displayName:'Sam',position:1}],revealedEmployee:{id,displayName:'Alex',team:null,funFact:'Fact',mediaAvailable:true,mediaKey:'F7K2M:0:reveal',revealKey:{key:'A'.repeat(43),iv:'B'.repeat(16),mimeType:'image/png',aad:`name-that:${id}:22222222-2222-4222-8222-222222222222`}},results:null,updatedAt:'2026-08-12T00:00:00Z',prompt:'Who?',mysteryImageUrl:null,silhouetteUrl:null,preloadAssets:[]};

describe('pushed snapshot parser',()=>{
  it('accepts a complete phase-gated reveal projection',()=>expect(parsePushedSnapshot(base,'F7K2M',8,'employee_revealed')).not.toBeNull());
  it('rejects stale/cross-room/nested malformed projections',()=>{
    expect(parsePushedSnapshot(base,'N8W2Q',8,'employee_revealed')).toBeNull();
    expect(parsePushedSnapshot({...base,version:7},'F7K2M',8,'employee_revealed')).toBeNull();
    expect(parsePushedSnapshot({...base,choices:[{...base.choices[0],id:'bad'}]},'F7K2M',8,'employee_revealed')).toBeNull();
  });
  it('rejects reveal material before reveal and cross-room preload paths',()=>{
    expect(parsePushedSnapshot({...base,phase:'question_open'},'F7K2M',8,'question_open')).toBeNull();
    expect(parsePushedSnapshot({...base,preloadAssets:[{key:'F7K2M:0:mystery',kind:'mystery',roundIndex:0,url:'/api/rooms/N8W2Q/mystery-preload?round=0'}]},'F7K2M',8,'employee_revealed')).toBeNull();
  });
  it('rejects dot segments, encoded paths, extra query data, and wrong preload endpoints',()=>{
    for(const url of ['/api/rooms/F7K2M/../N8W2Q/mystery-preload?round=0&asset=11111111-1111-4111-8111-111111111111','/api/rooms/F7K2M/%2e%2e/N8W2Q/mystery-preload?round=0&asset=11111111-1111-4111-8111-111111111111','/api/rooms/F7K2M/mystery-preload?round=0&asset=11111111-1111-4111-8111-111111111111&x=1','/api/rooms/F7K2M/reveal-preload?round=0&asset=11111111-1111-4111-8111-111111111111']){
      expect(parsePushedSnapshot({...base,preloadAssets:[{key:'F7K2M:0:mystery',kind:'mystery',roundIndex:0,url}]},'F7K2M',8,'employee_revealed')).toBeNull();
    }
  });
});

it('retains same-room same-round pushed reveal material across newer HTTP snapshots',()=>{
  const pushed=parsePushedSnapshot(base,'F7K2M',8,'employee_revealed')!;
  const http={...pushed,version:9,revealedEmployee:{...pushed.revealedEmployee!,revealKey:null}};
  expect(preserveRevealEnrichment(pushed,http).revealedEmployee?.revealKey).toEqual(pushed.revealedEmployee?.revealKey);
  expect(preserveRevealEnrichment(pushed,{...http,roundIndex:1}).revealedEmployee?.revealKey).toBeNull();
});

describe('snapshot source precedence',()=>{
  it('keeps versions monotonic and lets one equal-version push enrich HTTP',()=>{
    expect(shouldReplaceSnapshot('http',7,8,-1)).toBe(false);
    expect(shouldReplaceSnapshot('push',8,8,-1)).toBe(true);
    expect(shouldReplaceSnapshot('http',8,8,8)).toBe(false);
    expect(shouldReplaceSnapshot('push',8,8,8)).toBe(false);
    expect(shouldReplaceSnapshot('http',9,8,8)).toBe(true);
  });
});

it('merges equal-version aggregate progress without regressing the authoritative projection',()=>{
  const current=parsePushedSnapshot(base,'F7K2M',8,'employee_revealed')!;
  const next={...current,connectedParticipantCount:175,eligibleParticipantCount:170,submittedAnswerCount:169,prompt:'stale prompt',revealedEmployee:null,updatedAt:'2026-08-12T00:00:02Z'};
  const merged=mergeCountOnlySnapshot(current,next)!;
  expect(merged.connectedParticipantCount).toBe(175);
  expect(merged.submittedAnswerCount).toBe(169);
  expect(merged.prompt).toBe(current.prompt);
  expect(merged.revealedEmployee).toEqual(current.revealedEmployee);
  expect(mergeCountOnlySnapshot(current,{...next,version:9})).toBeNull();
});
