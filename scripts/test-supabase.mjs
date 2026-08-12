import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const url = process.env.SUPABASE_URL ?? required('VITE_SUPABASE_URL');
const projectRef = required('SUPABASE_PROJECT_REF');
const managementToken = required('SUPABASE_ACCESS_TOKEN');
const admin = createClient(url, required('SUPABASE_SECRET_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, required('VITE_SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const hash = async (value) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('');
const rpc = async (name, args) => {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
};
const expectMarker = async (name, args, marker) => {
  const result = await admin.rpc(name, args);
  assert(result.error?.message.includes(marker), `${name} should fail with ${marker}`);
};
const managementQuery = async (query) => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`, {
    method: 'POST', headers: { authorization: `Bearer ${managementToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Supabase management query failed (${response.status}).`);
  return response.json();
};
const managementAuthConfig = async () => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`, {
    headers: { authorization: `Bearer ${managementToken}` },
  });
  if (!response.ok) throw new Error(`Supabase Auth config read failed (${response.status}).`);
  return response.json();
};

const hostToken = token();
const participantToken = token();
const secondToken = token();
const roomCode = code();
const cleanupRooms = [];
let rateSourceHash;
let roomChannel;
let forgedObserverChannel;
let forgedObserver;
let realtimeAuthUserId;
let authCleanupError;
const cleanupErrors = [];
const inspectRoundSequence = async (roomId) => {
  const rounds = await admin.from('rounds').select('id,round_number,correct_employee_id').eq('room_id', roomId).order('round_number');
  assert(!rounds.error);
  assert.equal(rounds.data.length, 4);
  assert.equal(new Set(rounds.data.map((round) => round.correct_employee_id)).size, 4);
  for (const round of rounds.data) {
    const choices = await admin.from('round_choices').select('employee_id').eq('round_id', round.id);
    assert(!choices.error);
    assert.equal(choices.data.length, 4);
    assert(choices.data.some((choice) => choice.employee_id === round.correct_employee_id));
  }
  return rounds.data.map((round) => round.correct_employee_id).join(',');
};
try {
  const authConfig = await managementAuthConfig();
  assert.equal(authConfig.external_anonymous_users_enabled, true, 'Anonymous Auth must be enabled for private Realtime');
  assert(authConfig.rate_limit_anonymous_users >= 120, 'Anonymous Auth limit must support 100 participants behind one NAT');
  const created = await rpc('create_room', { p_code: roomCode, p_host_token_hash: await hash(hostToken) });
  const roomId = created.roomId;
  cleanupRooms.push({ roomId, roomCode });

  const privateRead = await anon.from('rooms').select('*');
  assert(privateRead.error, 'anon must not read rooms');
  const snapshotEnumeration = await anon.from('room_snapshots').select('*');
  assert(snapshotEnumeration.error, 'anon must not enumerate authoritative snapshots');
  const privateRpc = await anon.rpc('create_room', { p_code: code(), p_host_token_hash: await hash(token()) });
  assert(privateRpc.error, 'anon must not execute private RPCs');

  rateSourceHash = await hash(`integration-source:${token()}`);
  const limiterRace = await Promise.all(Array.from({ length: 6 }, () => admin.rpc('consume_room_creation_attempt', {
    p_source_hash: rateSourceHash,
  })));
  assert(limiterRace.every((result) => !result.error));
  assert.equal(limiterRace.filter((result) => result.data.allowed).length, 5);
  const limited = limiterRace.find((result) => !result.data.allowed)?.data;
  assert(limited?.retryAfterSeconds > 0);
  assert.equal(limited?.remaining, 0);
  const persistedLimit = await admin.from('room_creation_limits').select('attempts').eq('source_hash', `\\x${rateSourceHash}`).single();
  assert(!persistedLimit.error);
  assert.equal(persistedLimit.data.attempts, 6, 'rejected attempts must commit their counter');

  const anonMediaList = await anon.storage.from('reveal-media').list('portraits');
  assert(anonMediaList.error || anonMediaList.data.length === 0, 'anon must not list reveal-media objects');
  const anonMediaDownload = await anon.storage.from('reveal-media').download('portraits/jordan-brooks.webp');
  assert(anonMediaDownload.error, 'anon must not download a known reveal-media object');
  // Read-only preflight found zero storage.object policies. The migration must
  // add only its scoped restrictive policy, without unrelated policy mutation.
  const storagePolicies = await managementQuery("select policyname, permissive, cmd, roles::text as roles, qual from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname");
  assert.equal(storagePolicies.length, 1);
  assert.equal(storagePolicies[0].policyname, 'reveal_media_never_client_select');
  assert.equal(storagePolicies[0].permissive, 'RESTRICTIVE');
  assert.equal(storagePolicies[0].cmd, 'SELECT');
  assert.match(storagePolicies[0].roles, /anon/);
  assert.match(storagePolicies[0].roles, /authenticated/);
  assert.match(storagePolicies[0].qual, /reveal-media/);
  const realtimePolicies = await managementQuery("select policyname, permissive, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'room_snapshot_broadcast_%' order by policyname");
  assert.equal(realtimePolicies.length, 2);
  const receivePolicy = realtimePolicies.find((policy) => policy.policyname === 'room_snapshot_broadcast_receive');
  const sendDenyPolicy = realtimePolicies.find((policy) => policy.policyname === 'room_snapshot_broadcast_client_send_deny');
  assert.equal(receivePolicy?.cmd, 'SELECT');
  assert.match(receivePolicy?.qual, /room:/);
  assert.equal(sendDenyPolicy?.cmd, 'INSERT');
  assert.equal(sendDenyPolicy?.permissive, 'RESTRICTIVE');
  assert.match(sendDenyPolicy?.with_check, /room:/);

  const sequences = new Set([await inspectRoundSequence(roomId)]);
  for (let index = 0; index < 5; index += 1) {
    const randomCode = code();
    const randomRoom = await rpc('create_room', { p_code: randomCode, p_host_token_hash: await hash(token()) });
    cleanupRooms.push({ roomId: randomRoom.roomId, roomCode: randomCode });
    sequences.add(await inspectRoundSequence(randomRoom.roomId));
  }
  assert(sequences.size > 1, 'CSPRNG room sequences should not repeat a global fixed order');

  const expiryCode = code();
  const expiryRoom = await rpc('create_room', { p_code: expiryCode, p_host_token_hash: await hash(token()) });
  const markExpired = await admin.from('rooms').update({ updated_at: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() }).eq('id', expiryRoom.roomId);
  assert(!markExpired.error);
  const expiredCleanup = await rpc('cleanup_expired_rooms', {});
  assert(expiredCleanup.deletedRooms >= 1);
  const expiredRoomRead = await admin.from('rooms').select('id').eq('id', expiryRoom.roomId).maybeSingle();
  assert.equal(expiredRoomRead.data, null);
  const expiredSnapshotRead = await admin.from('room_snapshots').select('room_code').eq('room_code', expiryCode).maybeSingle();
  assert.equal(expiredSnapshotRead.data, null);
  const activeRoomRead = await admin.from('rooms').select('id').eq('id', roomId).single();
  assert(!activeRoomRead.error, 'cleanup must preserve active rooms');

  const capCode = code();
  const capRoom = await rpc('create_room', { p_code: capCode, p_host_token_hash: await hash(token()) });
  cleanupRooms.push({ roomId: capRoom.roomId, roomCode: capCode });
  const joinLoadPlayer = async (index) => admin.rpc('join_room', {
    p_code: capCode, p_display_name: `Load ${index + 1}`, p_participant_token_hash: await hash(token()),
  });
  for (let start = 0; start < 99; start += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, 99 - start) }, (_, offset) => joinLoadPlayer(start + offset)));
    assert(batch.every((result) => !result.error), 'prefill joins should succeed below the cap');
  }
  const boundaryRace = await Promise.all([joinLoadPlayer(99), joinLoadPlayer(100)]);
  assert.equal(boundaryRace.filter((result) => !result.error).length, 1);
  assert.equal(boundaryRace.filter((result) => result.error?.message.includes('ROOM_FULL')).length, 1);
  const cappedCount = await admin.from('players').select('*', { count: 'exact', head: true }).eq('room_id', capRoom.roomId);
  assert.equal(cappedCount.count, 100, 'concurrent joins must never exceed the transactional cap');

  const storedRoom = await admin.from('rooms').select('host_token_hash').eq('id', roomId).single();
  assert(!storedRoom.error);
  assert.notEqual(storedRoom.data.host_token_hash, hostToken, 'plaintext host token must not be persisted');

  const realtimeSignIn = await anon.auth.signInAnonymously({
    options: { data: { application: 'name-that-realtime' } },
  });
  if (realtimeSignIn.error || !realtimeSignIn.data.session || !realtimeSignIn.data.user) {
    throw new Error(`Anonymous Auth is required for private Realtime: ${realtimeSignIn.error?.message ?? 'session missing'}`);
  }
  realtimeAuthUserId = realtimeSignIn.data.user.id;
  await anon.realtime.setAuth(realtimeSignIn.data.session.access_token);
  const authenticatedSnapshotEnumeration = await anon.from('room_snapshots').select('*');
  assert(authenticatedSnapshotEnumeration.error, 'authenticated Realtime identity must not enumerate snapshots');
  const authenticatedPrivateRpc = await anon.rpc('host_action', {
    p_code: roomCode, p_host_token_hash: await hash(token()), p_action: 'start',
  });
  assert(authenticatedPrivateRpc.error, 'authenticated Realtime identity must not execute game RPCs');
  let resolveBroadcast;
  let rejectBroadcast;
  const broadcastReceived = new Promise((resolve, reject) => {
    resolveBroadcast = resolve;
    rejectBroadcast = reject;
  });
  roomChannel = anon.channel(`room:${roomCode}`, { config: { private: true, broadcast: { ack: true } } })
    .on('broadcast', { event: 'room_snapshot_changed' }, ({ payload }) => resolveBroadcast(payload));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Private room Broadcast subscription timed out.')), 10_000);
    roomChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(`Private room Broadcast failed: ${status}`)); }
    });
  });
  forgedObserver = createClient(url, required('VITE_SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  await forgedObserver.realtime.setAuth(realtimeSignIn.data.session.access_token);
  let forgedDelivered = false;
  forgedObserverChannel = forgedObserver.channel(`room:${roomCode}`, { config: { private: true } })
    .on('broadcast', { event: 'forged_room_update' }, () => { forgedDelivered = true; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Private forged-send observer timed out.')), 10_000);
    forgedObserverChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(`Private forged-send observer failed: ${status}`)); }
    });
  });
  const forgedSend = await roomChannel.send({ type: 'broadcast', event: 'forged_room_update', payload: { version: 999 } });
  assert.notEqual(forgedSend, 'ok', 'receive-only client must not send room broadcasts');
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(forgedDelivered, false, 'forged room broadcast must not reach another authenticated listener');
  await forgedObserver.removeChannel(forgedObserverChannel);
  forgedObserverChannel = undefined;
  forgedObserver = undefined;

  const player = await rpc('join_room', {
    p_code: roomCode, p_display_name: 'Ada', p_participant_token_hash: await hash(participantToken),
  });
  const broadcastTimeout = setTimeout(() => rejectBroadcast(new Error('Database room invalidation was not received.')), 10_000);
  const invalidation = await broadcastReceived;
  clearTimeout(broadcastTimeout);
  assert.equal(invalidation.roomCode, roomCode);
  assert(Number.isInteger(invalidation.version));
  await anon.removeChannel(roomChannel);
  roomChannel = undefined;
  const second = await rpc('join_room', {
    p_code: roomCode, p_display_name: 'Grace', p_participant_token_hash: await hash(secondToken),
  });
  await expectMarker('host_action', { p_code: roomCode, p_host_token_hash: await hash(token()), p_action: 'start' }, 'HOST_UNAUTHORIZED');
  const beforeDirect = await admin.from('rooms').select('phase,version').eq('id', roomId).single();
  assert(!beforeDirect.error);
  for (const args of [
    { p_code: roomCode, p_host_token: null, p_action: 'start' },
    { p_code: roomCode, p_action: 'start' },
    { p_code: roomCode, p_host_token: token(), p_action: 'start' },
    { p_code: roomCode, p_host_token: hostToken, p_action: 'unknown' },
  ]) {
    const rejected = await anon.rpc('host_action_direct', args);
    assert(rejected.error, `direct host action must reject ${JSON.stringify(args)}`);
  }
  const afterRejectedDirect = await admin.from('rooms').select('phase,version').eq('id', roomId).single();
  assert(!afterRejectedDirect.error);
  assert.deepEqual(afterRejectedDirect.data, beforeDirect.data, 'rejected direct credentials must not mutate phase or version');
  const directStart = await anon.rpc('host_action_direct', { p_code: roomCode, p_host_token: hostToken, p_action: 'start' });
  assert(!directStart.error, `valid direct host capability failed: ${directStart.error?.message}`);

  const hostView = await rpc('host_room', { p_code: roomCode, p_host_token_hash: await hash(hostToken) });
  assert(hostView.correctEmployee?.id, 'authenticated host should receive the current correct employee');
  assert.equal(hostView.roundCount, 4);
  assert.equal(hostView.isFinalRound, false);

  let snapshot = await admin.from('room_snapshots').select('*').eq('room_code', roomCode).single();
  assert(!snapshot.error);
  assert.equal(snapshot.data.choices.length, 4);
  assert.equal(snapshot.data.revealed_employee, null, 'identity must be hidden before reveal');
  assert.equal(snapshot.data.results, null, 'results must be hidden before results phase');
  assert(!Object.hasOwn(snapshot.data, 'correctEmployee'), 'public snapshot must not gain the host-only correct marker');
  const choiceId = snapshot.data.choices[0].id;

  await expectMarker('submit_answer', {
    p_code: roomCode, p_player_id: player.playerId, p_participant_token_hash: await hash(secondToken), p_employee_id: choiceId,
  }, 'PARTICIPANT_UNAUTHORIZED');
  await expectMarker('submit_answer', {
    p_code: roomCode, p_player_id: second.playerId, p_participant_token_hash: await hash(participantToken), p_employee_id: choiceId,
  }, 'PARTICIPANT_UNAUTHORIZED');

  const first = await rpc('submit_answer', {
    p_code: roomCode, p_player_id: player.playerId, p_participant_token_hash: await hash(participantToken), p_employee_id: choiceId,
  });
  assert.equal(first.idempotent, false);
  const duplicate = await rpc('submit_answer', {
    p_code: roomCode, p_player_id: player.playerId, p_participant_token_hash: await hash(participantToken), p_employee_id: choiceId,
  });
  assert.equal(duplicate.idempotent, true);
  await expectMarker('submit_answer', {
    p_code: roomCode, p_player_id: player.playerId, p_participant_token_hash: await hash(participantToken), p_employee_id: snapshot.data.choices[1].id,
  }, 'ANSWER_IMMUTABLE');

  await rpc('host_action', { p_code: roomCode, p_host_token_hash: await hash(hostToken), p_action: 'lock' });
  await expectMarker('submit_answer', {
    p_code: roomCode, p_player_id: second.playerId, p_participant_token_hash: await hash(secondToken), p_employee_id: choiceId,
  }, 'ANSWERS_CLOSED');
  await expectMarker('host_action', { p_code: roomCode, p_host_token_hash: await hash(hostToken), p_action: 'show_results' }, 'ILLEGAL_TRANSITION');
  await rpc('host_action', { p_code: roomCode, p_host_token_hash: await hash(hostToken), p_action: 'reveal' });
  snapshot = await admin.from('room_snapshots').select('*').eq('room_code', roomCode).single();
  assert(snapshot.data.revealed_employee?.id, 'correct identity should appear at reveal');
  assert.equal(snapshot.data.results, null);
  const path = await rpc('reveal_media_path', { p_code: roomCode, p_member_id: snapshot.data.revealed_employee.id });
  assert.match(path.storagePath, /^portraits\/.*\.webp$/);
  assert.equal(path.mimeType, 'image/webp');
  await rpc('host_action', { p_code: roomCode, p_host_token_hash: await hash(hostToken), p_action: 'show_results' });
  snapshot = await admin.from('room_snapshots').select('*').eq('room_code', roomCode).single();
  assert.equal(snapshot.data.results.totalAnswers, 1);
  assert.equal(snapshot.data.results.correctAnswers, choiceId === snapshot.data.revealed_employee.id ? 1 : 0);
  assert.equal(snapshot.data.results.choices.length, 4);
  assert.equal(snapshot.data.results.choices.reduce((sum, item) => sum + item.count, 0), 1);

  console.log('Supabase integration/security checks passed (RLS, CSPRNG layout, 100-player concurrency cap, credentials, Storage denial, transitions, leakage, result math).');
} finally {
  if (roomChannel) await anon.removeChannel(roomChannel);
  if (forgedObserverChannel && forgedObserver) await forgedObserver.removeChannel(forgedObserverChannel);
  if (realtimeAuthUserId) {
    const deletedAuthUser = await admin.auth.admin.deleteUser(realtimeAuthUserId);
    if (deletedAuthUser.error) authCleanupError = deletedAuthUser.error;
  }
  for (const room of cleanupRooms) {
    const deletedSnapshot = await admin.from('room_snapshots').delete().eq('room_code', room.roomCode);
    if (deletedSnapshot.error) cleanupErrors.push(`snapshot ${room.roomCode}: ${deletedSnapshot.error.message}`);
    const deletedRoom = await admin.from('rooms').delete().eq('id', room.roomId);
    if (deletedRoom.error) cleanupErrors.push(`room ${room.roomCode}: ${deletedRoom.error.message}`);
  }
  if (rateSourceHash) {
    try {
      await managementQuery(`delete from public.room_creation_limits where source_hash = decode('${rateSourceHash}', 'hex')`);
    } catch (error) {
      cleanupErrors.push(`limiter: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (authCleanupError) cleanupErrors.push(`Realtime test user: ${authCleanupError.message}`);
  if (cleanupErrors.length > 0) {
    console.error(`Integration cleanup failed: ${cleanupErrors.join('; ')}`);
    process.exitCode = 1;
  }
}
