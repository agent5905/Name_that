import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const baseUrl = new URL(process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8788');
const localHost = baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === 'localhost';
const approvedRemoteHost = process.env.SMOKE_ALLOW_REMOTE === 'true'
  && process.env.SMOKE_EXPECTED_HOST === baseUrl.hostname;
assert(
  localHost || approvedRemoteHost,
  'Remote smoke requires SMOKE_ALLOW_REMOTE=true and SMOKE_EXPECTED_HOST to exactly match SMOKE_BASE_URL.',
);
const cleanupUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
assert(cleanupUrl, 'SUPABASE_URL is required so the smoke can remove its test room.');
assert(process.env.SUPABASE_SECRET_KEY, 'SUPABASE_SECRET_KEY is required so the smoke can remove its test room.');
const cleanupClient = createClient(cleanupUrl, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function request(path, { method = 'GET', token, body, expectedStatus = 200, responseType = 'json' } = {}) {
  const headers = { accept: responseType === 'json' ? 'application/json' : '*/*' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expectedStatus, `${method} ${path} returned ${response.status}, expected ${expectedStatus}`);
  assert.equal(response.headers.get('cache-control')?.includes('no-store'), true, `${method} ${path} must be no-store`);
  if (responseType === 'bytes') return { response, body: await response.arrayBuffer() };
  return { response, body: await response.json() };
}

const appShell = await fetch(baseUrl);
assert.equal(appShell.status, 200, 'The deployed client shell must load.');
assert.match(appShell.headers.get('content-type') ?? '', /text\/html/);
assert.match(await appShell.text(), /<div id="root"><\/div>/);

const health = await request('/api/health');
assert.deepEqual(health.body, { status: 'ok', service: 'name-that-team-member' });

let cleanupRoom;
try {
const created = await request('/api/rooms', { method: 'POST', body: {}, expectedStatus: 201 });
const { code, roomId } = created.body.room;
const { hostToken } = created.body;
cleanupRoom = { code, roomId };
assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
assert.match(roomId, /^[0-9a-f-]{36}$/i);
assert.match(hostToken, /^[A-Za-z0-9_-]{43}$/);

const joined = await request(`/api/rooms/${code}/join`, {
  method: 'POST', body: { name: 'Pages Smoke Player', participantToken: randomBytes(32).toString('base64url'), idempotencyKey: randomUUID() }, expectedStatus: 201,
});
const { participant, participantToken } = joined.body;
assert.match(participant.playerId, /^[0-9a-f-]{36}$/i);
assert.match(participantToken, /^[A-Za-z0-9_-]{43}$/);

const lobby = await request(`/api/rooms/${code}/snapshot`);
assert.equal(lobby.body.snapshot.phase, 'lobby');
assert.equal(lobby.body.snapshot.connectedParticipantCount, 1);

const started = await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: hostToken, body: { action: 'start' },
});
assert.equal(started.body.snapshot.phase, 'question_open');
assert.equal(started.body.snapshot.choices.length, 4);

const host = await request(`/api/rooms/${code}/host`, { token: hostToken });
const correctId = host.body.host.correctEmployee.id;
const answerId = correctId;
const wrongId = started.body.snapshot.choices.find((choice) => choice.id !== correctId).id;

const secretMedia = await request(`/api/rooms/${code}/media/${correctId}`, { expectedStatus: 404 });
assert.equal(secretMedia.body.error.code, 'MEDIA_NOT_AVAILABLE');

const answered = await request(`/api/rooms/${code}/answers`, {
  method: 'POST', token: participantToken, body: { playerId: participant.playerId, choiceId: answerId, roundIndex: 0 },
});
assert.equal(answered.body.answer.accepted, true);
assert.equal(answered.body.answer.idempotent, false);
const replay = await request(`/api/rooms/${code}/answers`, {
  method: 'POST', token: participantToken, body: { playerId: participant.playerId, choiceId: answerId, roundIndex: 0 },
});
assert.equal(replay.body.answer.idempotent, true);

const participantSnapshot = await fetch(new URL(`/api/rooms/${code}/snapshot`, baseUrl), {
  headers: { authorization: `Bearer ${participantToken}`, 'x-player-id': participant.playerId },
});
assert.equal(participantSnapshot.status, 200);
assert.equal(participantSnapshot.headers.get('cache-control')?.includes('no-store'), true);
const participantState = await participantSnapshot.json();
assert.equal(participantState.participant.answerEmployeeId, answerId);
assert.equal(participantState.participant.totalScore, 0, 'current-round score must remain hidden before reveal');
assert.equal(participantState.participant.roundFeedback, null, 'correctness must remain hidden before reveal');

await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: participantToken, body: { action: 'lock' }, expectedStatus: 403,
});
const locked = await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: hostToken, body: { action: 'lock' },
});
assert.equal(locked.body.snapshot.phase, 'answers_locked');
await request(`/api/rooms/${code}/answers`, {
  method: 'POST', token: participantToken,
  body: { playerId: participant.playerId, choiceId: wrongId, roundIndex: 0 }, expectedStatus: 409,
});

const revealed = await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: hostToken, body: { action: 'reveal' },
});
assert.equal(revealed.body.snapshot.revealedEmployee.id, correctId);
assert.equal(revealed.body.snapshot.results, null);
const revealedParticipantResponse = await fetch(new URL(`/api/rooms/${code}/snapshot`, baseUrl), {
  headers: { authorization: `Bearer ${participantToken}`, 'x-player-id': participant.playerId },
});
assert.equal(revealedParticipantResponse.status, 200);
const revealedParticipantBody = await revealedParticipantResponse.json();
assert.equal(revealedParticipantBody.participant.roundFeedback.outcome, 'correct');
assert(revealedParticipantBody.participant.roundFeedback.points >= 750 && revealedParticipantBody.participant.roundFeedback.points <= 1000);
assert.equal(revealedParticipantBody.participant.totalScore, revealedParticipantBody.participant.roundFeedback.points);
await request(`/api/rooms/${code}/media/${wrongId}`, { expectedStatus: 404 });
const media = await request(`/api/rooms/${code}/media/${correctId}`, { responseType: 'bytes' });
assert.equal(media.response.headers.get('content-type'), 'image/webp');
assert(media.body.byteLength > 1_000, 'Protected reveal media should contain an actual WebP asset.');

const results = await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: hostToken, body: { action: 'show_results' },
});
assert.equal(results.body.snapshot.phase, 'results_displayed');
assert.equal(results.body.snapshot.results.totalAnswers, 1);
assert.equal(results.body.snapshot.results.choices.reduce((sum, choice) => sum + choice.count, 0), 1);
const leaderboard = await request(`/api/rooms/${code}/actions`, {
  method: 'POST', token: hostToken, body: { action: 'show_leaderboard' },
});
assert.equal(leaderboard.body.snapshot.phase, 'leaderboard_displayed');
assert.equal(leaderboard.body.snapshot.leaderboard.entries[0].displayName, 'Pages Smoke Player');
assert.equal(leaderboard.body.snapshot.leaderboard.entries[0].totalScore, revealedParticipantBody.participant.totalScore);

console.log(`${localHost ? 'Local' : 'Deployed'} Pages HTTP smoke passed for room ${code} (health, auth, score secrecy, idempotency, reveal, results, and leaderboard).`);
} finally {
  if (cleanupRoom) {
    const snapshotCleanup = await cleanupClient.from('room_snapshots').delete().eq('room_code', cleanupRoom.code);
    const roomCleanup = await cleanupClient.from('rooms').delete().eq('id', cleanupRoom.roomId);
    if (snapshotCleanup.error || roomCleanup.error) {
      console.error('Local Pages smoke could not remove its uniquely identified test room.');
      process.exitCode = 1;
    }
  }
}
