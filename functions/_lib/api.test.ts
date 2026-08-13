import { describe, expect, it } from 'vitest';
import {
  ApiError, bearerToken, displayName, json, newRoomCode, newToken, normalizeSnapshot,
  parseCleanupRealtimeAuth, parseCleanupRooms, parseCreatedRoom, parseHostRoom, parseJoinedParticipant,
  parseMediaByteLimit, parseRoomCreationLimit, parseSubmittedAnswer, readJson, requireAction, roomCode,
  roomCreationSourceHash, throwRpcError, tokenHash, uuid,
  preloadCacheKey, preloadQuery, realtimeAnonToken,
} from './api';
import { definition } from '../api/games/index';

describe('API boundary validation', () => {
  it('rejects discarded definition fields and validates explicit image/fun-fact content early',()=>{
    const id='550e8400-e29b-41d4-a716-446655440000';const base={name:'Game',questions:[{prompt:'Who?',revealName:'Ada',funFact:'Safe fact',mysteryMediaAssetId:id,revealMediaAssetId:id,choices:[{text:'Ada',isCorrect:true},{text:'Bob',isCorrect:false}]}]};
    expect(definition(base)).toMatchObject({questions:[{funFact:'Safe fact',mysteryMediaAssetId:id,revealMediaAssetId:id}]});
    expect(()=>definition({...base,unknown:true})).toThrow('unsupported field');
    expect(()=>definition({...base,questions:[{...base.questions[0],silentDrop:true}]})).toThrow('invalid');
    expect(()=>definition({...base,questions:[{...base.questions[0],revealMediaAssetId:'not-uuid'}]})).toThrow('valid pair');
    expect(()=>definition({...base,questions:[{...base.questions[0],funFact:'bad\u0000fact'}]})).toThrow('safe text');
  });
  it('accepts the intentionally unambiguous room alphabet', () => {
    expect(roomCode('AH2Z9')).toBe('AH2Z9');
    expect(() => roomCode('A10OZ')).toThrow(ApiError);
    expect(() => roomCode('abcde')).toThrow(ApiError);
  });

  it('normalizes participant names and bounds them', () => {
    expect(displayName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(() => displayName('')).toThrow(ApiError);
    expect(() => displayName('x'.repeat(41))).toThrow(ApiError);
  });

  it('requires strict UUIDs, actions, and 256-bit bearer tokens', () => {
    expect(uuid('550e8400-e29b-41d4-a716-446655440000')).toContain('550e');
    expect(() => uuid('not-an-id')).toThrow(ApiError);
    expect(requireAction('show_results')).toBe('show_results');
    expect(() => requireAction('skip')).toThrow(ApiError);
    expect(bearerToken(new Request('https://example.test', { headers: { authorization: `Bearer ${'a'.repeat(43)}` } }))).toHaveLength(43);
  });
  it('accepts only canonical immutable preload query identities',()=>{
    const id='550e8400-e29b-41d4-a716-446655440000';expect(preloadQuery(new Request(`https://example.test/x?round=1&asset=${id}`))).toEqual({round:1,asset:id});
    for(const query of [`?asset=${id}&round=1`,`?round=01&asset=${id}`,`?round=1&asset=${id}&x=1`,`?round=1&round=1&asset=${id}`,`?round=1&asset=${id.toUpperCase()}`])expect(()=>preloadQuery(new Request(`https://example.test/x${query}`))).toThrow('invalid');
  });
  it('canonicalizes preload cache identity from validated fields instead of the raw path',()=>{
    const id='550e8400-e29b-41d4-a716-446655440000';
    const key=preloadCacheKey(new Request(`https://example.test/alternate%2fpath?asset=ignored`),'AH2Z9','reveal',1,id);
    expect(key.url).toBe(`https://example.test/api/rooms/AH2Z9/reveal-preload?round=1&asset=${id}`);
  });

  it('rejects non-JSON and oversized bodies before parsing', async () => {
    await expect(readJson(new Request('https://example.test', { method: 'POST', body: 'x' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(readJson(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(9_000) }))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('credential primitives and service errors', () => {
  it('accepts only a non-expiring-soon HS256 anon JWT for private Realtime', () => {
    const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role: 'anon', exp: 2_000_000_000 })}.${'a'.repeat(43)}`;
    expect(realtimeAnonToken({ SUPABASE_REALTIME_ANON_KEY: token }, 1_900_000_000)).toBe(token);
    expect(() => realtimeAnonToken({ SUPABASE_REALTIME_ANON_KEY: `${part({ alg: 'HS256' })}.${part({ role: 'authenticated', exp: 2_000_000_000 })}.${'a'.repeat(43)}` }, 1_900_000_000))
      .toThrow('Realtime is temporarily unavailable.');
    expect(() => realtimeAnonToken({ SUPABASE_REALTIME_ANON_KEY: token }, 1_999_999_800))
      .toThrow('Realtime is temporarily unavailable.');
  });
  it('creates separate opaque 256-bit tokens and hashes them deterministically', async () => {
    const host = newToken();
    const participant = newToken();
    expect(host).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(participant).not.toBe(host);
    expect(await tokenHash(host)).toMatch(/^[0-9a-f]{64}$/);
    expect(await tokenHash(host)).toBe(await tokenHash(host));
  });

  it('hashes Cloudflare source IPs and uses a stable local fallback without retaining raw input', async () => {
    const first = await roomCreationSourceHash(new Request('https://example.test', { headers: { 'cf-connecting-ip': '203.0.113.8' } }));
    const again = await roomCreationSourceHash(new Request('https://example.test', { headers: { 'CF-Connecting-IP': '203.0.113.8' } }));
    const other = await roomCreationSourceHash(new Request('https://example.test', { headers: { 'cf-connecting-ip': '203.0.113.9' } }));
    const local = await roomCreationSourceHash(new Request('https://example.test'));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(local).toBe(await roomCreationSourceHash(new Request('http://localhost')));
    expect(first).not.toContain('203.0.113.8');
  });

  it('generates valid five-character codes', () => {
    for (let index = 0; index < 100; index += 1) expect(newRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
  });

  it('validates the aggregate source byte gate without trusting malformed counters',()=>{
    expect(parseMediaByteLimit({allowed:true,limitBytes:262144000,remainingBytes:100,retryAfterSeconds:0})).toEqual({allowed:true,limitBytes:262144000,remainingBytes:100,retryAfterSeconds:0});
    expect(()=>parseMediaByteLimit({allowed:true,limitBytes:1,remainingBytes:0,retryAfterSeconds:0})).toThrow();
  });

  it('maps known database markers without leaking unknown details', () => {
    try {
      throwRpcError({ message: 'HOST_UNAUTHORIZED secret detail' });
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'HOST_UNAUTHORIZED' });
    }
    try {
      throwRpcError({ message: 'password=should-not-escape' });
    } catch (error) {
      expect(error).toMatchObject({ status: 500, code: 'DATA_SERVICE_ERROR', message: 'The data service could not complete the request.' });
    }
    try {
      throwRpcError({ message: 'ROOM_FULL internal detail' });
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'ROOM_FULL', message: 'Room has reached its 225-player limit.' });
    }
  });

  it('allowlists and validates every private RPC response shape', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseCreatedRoom({ roomId: id, code: 'AH2Z9', secret: 'drop' })).toEqual({ roomId: id, code: 'AH2Z9' });
    expect(parseJoinedParticipant({ playerId: id, roomId: id, displayName: 'Ada', eligibleFromRound: 0, hash: 'drop' })).toEqual({ playerId: id, roomId: id, displayName: 'Ada', eligibleFromRound: 0 });
    expect(() => parseJoinedParticipant({ playerId: id, roomId: id, displayName: 'Ada', eligibleFromRound: -1 })).toThrow();
    expect(parseSubmittedAnswer({ accepted: true, idempotent: false, employeeId: id, rawVote: 'drop' })).toEqual({ accepted: true, idempotent: false, employeeId: id });
    expect(parseHostRoom({
      roomId: id, code: 'AH2Z9', phase: 'question_open', currentRound: 0,
      roundCount: 4, isFinalRound: false,
      correctEmployee: { id, displayName: 'Ada', team: 'Engineering', funFact: 'drop' },
      version: 2, host_token_hash: 'drop',
    })).toEqual({
      roomId: id, code: 'AH2Z9', phase: 'question_open', currentRound: 0,
      roundCount: 4, isFinalRound: false,
      correctEmployee: { id, displayName: 'Ada', team: 'Engineering' }, version: 2,
    });
    expect(() => parseCreatedRoom({ roomId: id, code: 'bad' })).toThrow('Invalid data service response.');
    expect(() => parseSubmittedAnswer({ accepted: 'yes', idempotent: false, employeeId: id })).toThrow('Invalid data service response.');
  });

  it('allowlists limiter and cleanup responses and supports Retry-After', () => {
    expect(parseRoomCreationLimit({ allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 120, internal: 'drop' }))
      .toEqual({ allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 120 });
    expect(parseRoomCreationLimit({ allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0 },20))
      .toEqual({ allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0 });
    expect(parseCleanupRooms({ deletedRooms: 2, deletedSnapshots: 2, ids: ['drop'] }))
      .toEqual({ deletedRooms: 2, deletedSnapshots: 2 });
    expect(parseCleanupRealtimeAuth({ deletedUsers: 3, ids: ['drop'] }))
      .toEqual({ deletedUsers: 3 });
    expect(() => parseRoomCreationLimit({ allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 0 })).toThrow('Invalid data service response.');
    expect(() => parseCleanupRooms({ deletedRooms: 1, deletedSnapshots: 2 })).toThrow('Invalid data service response.');
    expect(() => parseCleanupRealtimeAuth({ deletedUsers: -1 })).toThrow('Invalid data service response.');
    const response = json({ error: { code: 'ROOM_CREATION_RATE_LIMITED' } }, 429, { 'retry-after': '120' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('sanitized API snapshot shape', () => {
  it('normalizes only the sanctioned columns', () => {
    const snapshot = normalizeSnapshot({
      room_code: 'ABCDE', phase: 'lobby', host_token_hash: 'never', results: null,
      prompt: 'Name this mystery teammate', silhouette_url: '/api/rooms/ABCDE/silhouette',
    });
    expect(snapshot).not.toHaveProperty('host_token_hash');
    expect(snapshot).toMatchObject({
      roomCode: 'ABCDE', phase: 'lobby', results: null,
      prompt: 'Name this mystery teammate', silhouetteUrl: '/api/rooms/ABCDE/silhouette',
    });
  });
  it('allowlists preload descriptors and never forwards arbitrary URLs or secret fields',()=>{
    const normalized=normalizeSnapshot({room_code:'ABCDE',phase:'lobby',preload_assets:[{key:'ABCDE:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'/api/rooms/ABCDE/reveal-preload?round=0&asset=550e8400-e29b-41d4-a716-446655440000',storagePath:'secret'}]});
    expect(normalized.preloadAssets).toEqual([{key:'ABCDE:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'/api/rooms/ABCDE/reveal-preload?round=0&asset=550e8400-e29b-41d4-a716-446655440000'}]);
    expect(()=>normalizeSnapshot({preload_assets:[{key:'ABCDE:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'https://evil.example/reveal'}]})).toThrow('Invalid data service response.');
    expect(()=>normalizeSnapshot({room_code:'ABCDE',preload_assets:[{key:'ZZZZZ:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'/api/rooms/ABCDE/reveal-preload?round=0&asset=550e8400-e29b-41d4-a716-446655440000'}]})).toThrow('Invalid data service response.');
    expect(()=>normalizeSnapshot({room_code:'ABCDE',preload_assets:[{key:'ABCDE:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'/api/rooms/ABCDE/reveal-preload?round=1&asset=550e8400-e29b-41d4-a716-446655440000'}]})).toThrow('Invalid data service response.');
    expect(()=>normalizeSnapshot({room_code:'ABCDE',preload_assets:[{key:'ABCDE:0:reveal',kind:'reveal-encrypted',roundIndex:0,url:'/api/rooms/ABCDE/reveal-preload?round=0&asset=550e8400-e29b-41d4-a716-446655440000&extra=x'}]})).toThrow('Invalid data service response.');
  });
});
