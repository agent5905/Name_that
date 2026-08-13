import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { PNG } from 'pngjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const stages = process.argv.slice(2).map(Number);
const allowed = new Set([5, 10, 25, 50, 100, 175, 225]);
if (!stages.length || stages.some((stage) => !Number.isInteger(stage) || !allowed.has(stage))) {
  throw new Error('Pass one or more ordered stages from 5, 10, 25, 50, 100, 175, and 225.');
}
if (stages.some((stage, index) => index > 0 && stage <= stages[index - 1])) {
  throw new Error('Stages must be strictly increasing.');
}
const origin = required('CAPACITY_ORIGIN').replace(/\/$/, '');
const expectedHostname = required('CAPACITY_EXPECTED_HOSTNAME');
if (new URL(origin).hostname !== expectedHostname || !expectedHostname.endsWith('.pages.dev')) {
  throw new Error('CAPACITY_ORIGIN must exactly match the acknowledged Pages hostname.');
}
if (process.env.CAPACITY_ALLOW_REMOTE !== '1' || process.env.CAPACITY_ALLOW_REMOTE_DATA !== '1') {
  throw new Error('Both remote acknowledgements are required.');
}
const supabaseUrl = required('VITE_SUPABASE_URL');
const secret = required('SUPABASE_SECRET_KEY');
const publishableKey = required('VITE_SUPABASE_PUBLISHABLE_KEY');
const expectedSupabase = required('CAPACITY_EXPECTED_SUPABASE_HOSTNAME');
if (new URL(supabaseUrl).hostname !== expectedSupabase) throw new Error('Supabase hostname acknowledgement mismatch.');
const commit = required('CAPACITY_GIT_COMMIT');
const deploymentId = required('CAPACITY_DEPLOYMENT_ID');
const outputDirectory = resolve(process.env.CAPACITY_OUTPUT_DIRECTORY ?? 'docs/capacity-results');
const workspaceDirectory = resolve('.capacity-work');
const admin = createClient(supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const fixture = { adminId: '', gameId: '', mediaPaths: [] };

function png(role, round) {
  const image = new PNG({ width: 48, height: 60 });
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const offset = (y * image.width + x) * 4;
    const stripe = (x + y + round * 7) % 13 < 6;
    const colors = role === 'mystery' ? [[8, 31, 58], [22, 213, 214]] : [[250, 239, 209], [238, 92, 70]];
    const color = colors[stripe ? 0 : 1];
    image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]; image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image, { colorType: 6 });
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = new Headers({ accept: 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined && !(body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(`${origin}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${payload?.error?.code ?? `HTTP_${response.status}`} (${response.status})`);
  return payload;
}

async function createFixture() {
  const session = await api('/api/admin/session', { method: 'POST', body: {} });
  fixture.adminId = session.admin.id;
  const adminToken = session.adminToken;
  const draft = await api('/api/games', { method: 'POST', token: adminToken, body: { name: `Capacity fixture ${Date.now()}`, questions: [] } });
  fixture.gameId = draft.game.id;
  const mediaIds = [];
  for (let round = 0; round < 3; round += 1) {
    const form = new FormData();
    form.set('mystery', new Blob([png('mystery', round)], { type: 'image/png' }), `mystery-${round + 1}.png`);
    form.set('reveal', new Blob([png('reveal', round)], { type: 'image/png' }), `reveal-${round + 1}.png`);
    const uploaded = await api(`/api/games/${fixture.gameId}/media`, { method: 'POST', token: adminToken, body: form });
    mediaIds.push(uploaded.media.id);
  }
  const questions = mediaIds.map((mediaId, round) => ({
    prompt: `Capacity round ${round + 1}`,
    revealName: `Teammate ${round + 1}`,
    mysteryMediaAssetId: mediaId,
    revealMediaAssetId: mediaId,
    funFact: `Lightweight capacity fixture round ${round + 1}.`,
    choices: Array.from({ length: 4 }, (_, choice) => ({ text: `Choice ${round + 1}.${choice + 1}`, isCorrect: choice === round % 4 })),
  }));
  await api(`/api/games/${fixture.gameId}`, { method: 'PUT', token: adminToken, body: { name: draft.game.name, revision: draft.game.revision, questions } });
  const paths = await admin.from('game_media_assets').select('mystery_storage_path,reveal_storage_path').eq('game_id', fixture.gameId);
  if (paths.error) throw paths.error;
  fixture.mediaPaths = (paths.data ?? []).flatMap((row) => [row.mystery_storage_path, row.reveal_storage_path].filter(Boolean));
  return adminToken;
}

function runStage(stage, adminToken) {
  return new Promise((resolvePromise, reject) => {
    const output = resolve(outputDirectory, `${stage}-client.json`);
    const child = spawn(process.execPath, ['scripts/load-capacity.mjs', '--execute', `--participants=${stage}`, '--rounds=3', `--output=${output}`], {
      cwd: process.cwd(), stdio: 'inherit', env: {
        ...process.env,
        CAPACITY_ALLOW_CLIENTS: String(stage),
        CAPACITY_GAME_ID: fixture.gameId,
        CAPACITY_ADMIN_TOKEN: adminToken,
        CAPACITY_GIT_COMMIT: commit,
        CAPACITY_DEPLOYMENT_ID: deploymentId,
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_SECRET_KEY: secret,
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Capacity stage ${stage} failed with exit ${code}.`)));
  });
}

async function cleanup() {
  const errors = [];
  if (fixture.gameId) {
    const rooms = await admin.from('rooms').select('id,code').eq('game_id', fixture.gameId);
    if (rooms.error) errors.push(`rooms read: ${rooms.error.message}`);
    else for (const room of rooms.data ?? []) {
      const snapshot = await admin.from('room_snapshots').delete().eq('room_code', room.code);
      const removed = await admin.from('rooms').delete().eq('id', room.id).eq('game_id', fixture.gameId);
      if (snapshot.error) errors.push(`snapshot ${room.code}: ${snapshot.error.message}`);
      if (removed.error) errors.push(`room ${room.code}: ${removed.error.message}`);
    }
  }
  if (fixture.adminId) {
    const removed = await admin.from('admin_profiles').delete().eq('id', fixture.adminId);
    if (removed.error) errors.push(`admin: ${removed.error.message}`);
  }
  if (fixture.mediaPaths.length) {
    const removed = await admin.storage.from('reveal-media').remove(fixture.mediaPaths);
    if (removed.error) errors.push(`storage: ${removed.error.message}`);
  }
  if (fixture.gameId) {
    const games = await admin.from('games').select('*', { count: 'exact', head: true }).eq('id', fixture.gameId);
    const rooms = await admin.from('rooms').select('*', { count: 'exact', head: true }).eq('game_id', fixture.gameId);
    if (games.error || games.count !== 0) errors.push('game cleanup verification failed');
    if (rooms.error || rooms.count !== 0) errors.push('room cleanup verification failed');
  }
  await rm(workspaceDirectory, { recursive: true, force: true });
  if (errors.length) throw new Error(errors.join('; '));
}

let failure;
try {
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(workspaceDirectory, { recursive: true });
  const adminToken = await createFixture();
  for (const stage of stages) await runStage(stage, adminToken);
} catch (error) {
  failure = error;
} finally {
  try { await cleanup(); } catch (cleanupError) { failure = new AggregateError([failure, cleanupError].filter(Boolean), 'Capacity run or cleanup failed.'); }
}
if (failure) throw failure;
console.log(`Capacity stages ${stages.join(', ')} passed; exact fixture cleanup verified.`);
