import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import type { ParticipantSession } from '../src/lib/session';
import {
  emulateLiveEventNetwork, expectPreloadPlanFetched, expectStableEditorLayout,
  installMysteryRenderProbe, installRevealRenderProbe, observeImagePerformance, preloadDescriptors,
  REVEAL_RENDER_TARGET_MS, revealRenderLatency, sampleLayout,
} from './imagePerformance';

/**
 * Destructive, real-backend acceptance suite.
 *
 * This file is intentionally skipped during the normal mocked/local E2E run. To
 * point a browser at the real Pages deployment, both the opt-in and the exact
 * hostname acknowledgement must be present:
 *
 *   ACCEPTANCE_REAL=1
 *   ACCEPTANCE_ORIGIN=https://name-that-team-member.pages.dev
 *   ACCEPTANCE_EXPECTED_HOSTNAME=name-that-team-member.pages.dev
 *   SUPABASE_URL=...
 *   SUPABASE_SECRET_KEY=...
 *
 * The suite never intercepts /api. Cleanup uses the service credential only in
 * this Node process and deletes the one isolated admin profile created by the
 * browser, its exact rooms, and its exact Storage objects.
 */

const RUN_REAL = process.env.ACCEPTANCE_REAL === '1';
const ORIGIN_TEXT = process.env.ACCEPTANCE_ORIGIN ?? '';
const EXPECTED_HOSTNAME = process.env.ACCEPTANCE_EXPECTED_HOSTNAME ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? '';
const GAME_NAME = 'Summer Team Ice Breaker';
const EDITED_GAME_NAME = 'Summer Team Ice Breaker — Remix';
const ACTION_TIMEOUT = 30_000;

interface AdminIdentity { readonly id: string; readonly token: string }
interface HostIdentity {
  readonly roomId: string;
  readonly code: string;
  readonly token: string;
  readonly gameId?: string;
  readonly gameRevision?: number;
  readonly gameName?: string;
}

interface ParticipantHandle {
  readonly context: BrowserContext;
  readonly page: Page;
}

let origin = '';
let admin: AdminIdentity | null = null;
let gameId = '';
let currentHost: HostIdentity | null = null;
let fixtureDirectory = '';
let mysteryWide = '';
let revealWide = '';
let mysteryTall = '';
let revealTall = '';
let mysterySquare = '';
let revealSquare = '';
const createdCodes = new Set<string>();
const completedCodes = new Set<string>();

function validateRemoteOptIn() {
  if (!RUN_REAL) return;
  if (!ORIGIN_TEXT || !EXPECTED_HOSTNAME) {
    throw new Error('Real acceptance requires ACCEPTANCE_ORIGIN and ACCEPTANCE_EXPECTED_HOSTNAME.');
  }
  const parsed = new URL(ORIGIN_TEXT);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ACCEPTANCE_ORIGIN must be a bare HTTPS origin.');
  }
  if (parsed.hostname !== EXPECTED_HOSTNAME) {
    throw new Error(`Refusing remote execution: ${parsed.hostname} does not equal acknowledged hostname ${EXPECTED_HOSTNAME}.`);
  }
  if (!EXPECTED_HOSTNAME.endsWith('.pages.dev')) {
    throw new Error('Real acceptance is restricted to an explicitly acknowledged Cloudflare Pages hostname.');
  }
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error('Real acceptance cleanup requires SUPABASE_URL and SUPABASE_SECRET_KEY in Node.');
  }
  origin = parsed.origin;
}

function makePortrait(width: number, height: number, base: readonly [number, number, number], textured = false) {
  const png = new PNG({ width, height });
  let seed = (base[0] << 16) ^ (base[1] << 8) ^ base[2];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const spotlight = Math.max(0, 1 - Math.hypot(x - width * .5, y - height * .42) / Math.max(width, height));
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = textured ? ((seed >>> 24) - 128) * .42 : 0;
    png.data[offset] = Math.max(0, Math.min(255, Math.round(base[0] + 75 * spotlight + noise)));
    png.data[offset + 1] = Math.max(0, Math.min(255, Math.round(base[1] + 65 * spotlight + noise)));
    png.data[offset + 2] = Math.max(0, Math.min(255, Math.round(base[2] + 55 * spotlight + noise)));
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function writePortraitFixtures() {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'name-that-acceptance-'));
  mysteryWide = join(fixtureDirectory, 'mystery-wide-480x220.png');
  revealWide = join(fixtureDirectory, 'reveal-wide-900x1125.png');
  mysteryTall = join(fixtureDirectory, 'mystery-tall-220x480.png');
  revealTall = join(fixtureDirectory, 'reveal-tall-900x1125.png');
  mysterySquare = join(fixtureDirectory, 'mystery-square-360x360.png');
  revealSquare = join(fixtureDirectory, 'reveal-square-900x1125.png');
  await Promise.all([
    writeFile(mysteryWide, makePortrait(480, 220, [5, 18, 34])),
    writeFile(revealWide, makePortrait(900, 1125, [18, 88, 154], true)),
    writeFile(mysteryTall, makePortrait(220, 480, [30, 8, 20])),
    writeFile(revealTall, makePortrait(900, 1125, [164, 44, 62], true)),
    writeFile(mysterySquare, makePortrait(360, 360, [12, 38, 18])),
    writeFile(revealSquare, makePortrait(900, 1125, [62, 118, 38], true)),
  ]);
}

async function goto(page: Page, path: string) {
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
}

async function readLocalStorage<T>(page: Page, key: string): Promise<T> {
  await expect.poll(() => page.evaluate((storageKey) => localStorage.getItem(storageKey), key), { timeout: ACTION_TIMEOUT }).not.toBeNull();
  const value = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
  if (!value) throw new Error(`Missing ${key} in localStorage.`);
  return JSON.parse(value) as T;
}

async function installAdmin(page: Page) {
  if (!admin) throw new Error('The isolated admin identity has not been created yet.');
  await page.addInitScript((identity) => localStorage.setItem('name-that:admin', JSON.stringify(identity)), admin);
}

async function installHost(page: Page, host: HostIdentity) {
  await page.addInitScript((identity) => localStorage.setItem('name-that:host', JSON.stringify(identity)), host);
}

async function captureHost(page: Page) {
  const host = await readLocalStorage<HostIdentity>(page, 'name-that:host');
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(host.code)) throw new Error(`Unexpected room code ${host.code}.`);
  currentHost = host;
  createdCodes.add(host.code);
  return host;
}

async function expectImageReady(locator: ReturnType<Page['locator']>) {
  await expect(locator).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect.poll(() => locator.evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: ACTION_TIMEOUT }).toBeGreaterThan(0);
}

async function setQuestion(
  page: Page,
  input: {
    prompt: string; revealName: string; funFact: string; choices: readonly string[]; correct: number;
    mysteryImage: string; revealImage: string;
  },
) {
  await page.getByLabel('Question prompt').fill(input.prompt);
  await page.getByLabel('Employee / reveal name').fill(input.revealName);
  await page.getByLabel('Fun Fact (optional)').fill(input.funFact);
  const add = page.getByRole('button', { name: /Add answer/ });
  while (await page.locator('.answer-row').count() < input.choices.length) await add.click();
  while (await page.locator('.answer-row').count() > input.choices.length) {
    const count = await page.locator('.answer-row').count();
    await page.getByLabel(`Remove answer ${count}`).click();
  }
  for (const [index, choice] of input.choices.entries()) await page.getByRole('textbox', { name: `Answer ${index + 1}`, exact: true }).fill(choice);
  await page.getByLabel(`Mark answer ${input.correct + 1} correct`).check();
  await page.getByLabel('Mystery Image').setInputFiles(input.mysteryImage);
  await page.getByLabel('Reveal Image').setInputFiles(input.revealImage);
  await expectImageReady(page.getByRole('img', { name: 'Mystery Image preview' }));
  await expectImageReady(page.getByRole('img', { name: 'Reveal Image preview' }));
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expectImageReady(page.getByRole('img', { name: `Portrait of ${input.revealName}` }));
  await expect(page.locator('.preview-stage')).toContainText(input.funFact);
  await page.getByRole('button', { name: 'Mystery', exact: true }).click();
  await expect(page.locator('.preview-stage img')).toBeVisible();
}

async function saveGame(page: Page) {
  const button = page.getByRole('button', { name: /Save game/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.notice--error')).toHaveCount(0);
}

function recordDialogs(page: Page) {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return messages;
}

async function clickHostAction(page: Page, name: RegExp | string, next: RegExp | string) {
  const button = page.getByRole('button', { name });
  await expect(button).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: next })).toBeVisible({ timeout: ACTION_TIMEOUT });
}

async function completeFromLobby(
  page: Page,
  roundCount: number,
  participant?: Page,
  display?: Page,
  funFacts: readonly string[] = [],
) {
  await clickHostAction(page, /Start round/, /Lock answers/);
  for (let round = 0; round < roundCount; round += 1) {
    const mysterySources: string[] = [];
    if (display) {
      const mystery = display.locator('.portrait-chamber.is-concealed img');
      await expectImageReady(mystery);
      mysterySources.push(await mystery.getAttribute('src') ?? '');
    }
    if (participant) {
      await expect(participant.locator('.choice')).toHaveCount(round === 0 ? 3 : 5, { timeout: ACTION_TIMEOUT });
      const mystery = participant.locator('.portrait-chamber.is-concealed img');
      await expectImageReady(mystery);
      mysterySources.push(await mystery.getAttribute('src') ?? '');
      await participant.locator('.choice').first().click();
      await expect(participant.getByText(/Locked in:/)).toBeVisible({ timeout: ACTION_TIMEOUT });
    }
    await clickHostAction(page, /Lock answers/, /Reveal teammate/);
    await clickHostAction(page, /Reveal teammate/, /Show results/);
    for (const client of [display, participant].filter((candidate): candidate is Page => Boolean(candidate))) {
      const reveal = client.locator('.portrait-chamber.is-revealed img');
      await expectImageReady(reveal);
      expect(mysterySources).not.toContain(await reveal.getAttribute('src') ?? '');
      if (funFacts[round]) await expect(client.getByText(funFacts[round], { exact: false })).toBeVisible();
    }
    await clickHostAction(page, /Show results/, round === roundCount - 1 ? /Show final leaderboard/ : /Next round/);
    if (round === roundCount - 1) {
      await clickHostAction(page, /Show final leaderboard/, /Finish game/);
      if (display) {
        const finalBoard=display.getByRole('region',{name:'Final leaderboard'});
        await expect(finalBoard).toBeVisible({timeout:ACTION_TIMEOUT});
        await expect(finalBoard.locator('b').first()).toHaveText(/\d/,{timeout:ACTION_TIMEOUT});
      }
      if (participant) await expect(participant.getByText(/points/).first()).toBeVisible({timeout:ACTION_TIMEOUT});
      await page.getByRole('button', { name: /Finish game/ }).click();
      await expect(page.getByRole('button', { name: /Play again/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    } else {
      await page.getByRole('button', { name: /Next round/ }).click();
      await expect(page.getByRole('button', { name: /Lock answers/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    }
  }
  const host = await readLocalStorage<HostIdentity>(page, 'name-that:host');
  completedCodes.add(host.code);
}

async function createHostFromLibrary(page: Page, name: string) {
  await installAdmin(page);
  await goto(page, '/host');
  const card = page.locator('.game-poster').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toBeVisible({ timeout: ACTION_TIMEOUT });
  await card.getByRole('button', { name: /Host now/ }).click();
  await expect(page.getByRole('button', { name: /Start round/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
  return captureHost(page);
}

async function joinParticipant(browser: Browser, code: string, name: string, manual = false): Promise<ParticipantHandle> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  if (manual) {
    await goto(page, '/');
    await page.getByLabel('Room code').fill(code);
    await page.getByRole('button', { name: /Enter the studio/ }).click();
    await expect(page).toHaveURL(`${origin}/join/${code}`);
  } else await goto(page, `/join/${code}`);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: /ready/i }).click();
  await expect(page).toHaveURL(`${origin}/play/${code}`, { timeout: ACTION_TIMEOUT });
  return { context, page };
}

async function createHostViaApi(page: Page): Promise<HostIdentity> {
  if (!admin || !gameId) throw new Error('The isolated admin/game is not ready.');
  const hostToken = randomBytes(32).toString('base64url');
  const response = await page.request.post(`${origin}/api/games/${gameId}/sessions`, {
    headers: { authorization: `Bearer ${admin.token}` },
    data: { hostToken, idempotencyKey: randomUUID() },
  });
  expect(response.status()).toBe(201);
  const value = await response.json() as { room: Omit<HostIdentity, 'token'> };
  const host = { ...value.room, token: hostToken };
  createdCodes.add(host.code);
  return host;
}

async function createReplayViaApi(page: Page, previous: HostIdentity): Promise<HostIdentity> {
  const hostToken = randomBytes(32).toString('base64url');
  const response = await page.request.post(`${origin}/api/rooms/${previous.code}/play-again`, {
    headers: { authorization: `Bearer ${previous.token}` },
    data: { hostToken, idempotencyKey: randomUUID() },
  });
  expect(response.status()).toBe(201);
  const value = await response.json() as { room: Omit<HostIdentity, 'token'> };
  const host = { ...value.room, token: hostToken };
  createdCodes.add(host.code);
  return host;
}

async function apiHostAction(page: Page, host: HostIdentity, action: string) {
  const response = await page.request.post(`${origin}/api/rooms/${host.code}/actions`, {
    headers: { authorization: `Bearer ${host.token}` }, data: { action },
  });
  expect(response.ok(), `${action} ${host.code}: ${response.status()} ${await response.text()}`).toBe(true);
}

interface LivePreloadAsset { readonly key: string; readonly kind: string; readonly roundIndex: number; readonly url: string }
interface LiveRevealKey { readonly key: string; readonly iv: string; readonly mimeType: string; readonly aad: string }

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

async function decryptLiveReveal(ciphertext: ArrayBuffer, material: LiveRevealKey): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', decodeBase64Url(material.key), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({
    name: 'AES-GCM', iv: decodeBase64Url(material.iv), additionalData: new TextEncoder().encode(material.aad),
  }, key, ciphertext);
}

async function snapshotViaApi(page: Page, code: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${origin}/api/rooms/${code}/snapshot`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { snapshot: Record<string, unknown> }).snapshot;
}

function liveAsset(snapshot: Record<string, unknown>, kind: LivePreloadAsset['kind'], roundIndex = 0): LivePreloadAsset {
  const assets = snapshot.preloadAssets;
  if (!Array.isArray(assets)) throw new Error('Snapshot has no preload assets.');
  const asset = assets.find((raw): raw is LivePreloadAsset => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const value = raw as Record<string, unknown>;
    return value.kind === kind && value.roundIndex === roundIndex && typeof value.key === 'string' && typeof value.url === 'string';
  });
  if (!asset) throw new Error(`Snapshot has no ${kind} preload for round ${roundIndex}.`);
  return asset;
}

async function revealKeyViaApi(page: Page, code: string, choiceId: string) {
  return page.request.get(`${origin}/api/rooms/${code}/reveal-key/${choiceId}`);
}

async function fetchPreloadUntilHit(page: Page, url: string) {
  let response = await page.request.get(url);
  const firstStatus = response.headers()['x-name-that-cache'];
  expect(['MISS', 'HIT']).toContain(firstStatus);
  for (let attempt = 0; attempt < 8 && response.headers()['x-name-that-cache'] !== 'HIT'; attempt += 1) {
    await page.waitForTimeout(100 * (attempt + 1));
    response = await page.request.get(url);
  }
  expect(response.headers()['x-name-that-cache']).toBe('HIT');
  return { firstStatus, response };
}

async function finishViaApi(page: Page, host: HostIdentity, rounds = 2) {
  await apiHostAction(page, host, 'start');
  for (let index = 0; index < rounds; index += 1) {
    await apiHostAction(page, host, 'lock');
    await apiHostAction(page, host, 'reveal');
    await apiHostAction(page, host, 'show_results');
    if (index === rounds - 1) {
      await apiHostAction(page, host, 'show_leaderboard');
      await apiHostAction(page, host, 'end');
    } else await apiHostAction(page, host, 'next_round');
  }
  completedCodes.add(host.code);
}

async function spaNavigate(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function joinInSameTab(page: Page, code: string, name: string) {
  await expect(page).toHaveURL(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:join|play)/${code}$`), { timeout: ACTION_TIMEOUT });
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: /ready/i }).click();
  await expect(page).toHaveURL(`${origin}/play/${code}`, { timeout: ACTION_TIMEOUT });
}

async function refreshAndSee(page: Page, content: RegExp | string) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(content).first()).toBeVisible({ timeout: ACTION_TIMEOUT });
}

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function cleanupExactTestData() {
  if (!admin) return;
  const supabase = serviceClient();
  const { data: games, error: gamesError } = await supabase.from('games').select('id').eq('owner_id', admin.id);
  if (gamesError) throw gamesError;
  const ids = (games ?? []).map((game: { id: string }) => game.id);
  if (ids.length) {
    const { data: rooms, error: roomsError } = await supabase.from('rooms').select('id').in('game_id', ids);
    if (roomsError) throw roomsError;
    const roomIds = (rooms ?? []).map((room: { id: string }) => room.id);
    if (roomIds.length) {
      const { error } = await supabase.from('rooms').delete().in('id', roomIds);
      if (error) throw error;
    }
  }
  const { data: media, error: mediaError } = await supabase
    .from('game_media_assets')
    .select('storage_path,silhouette_storage_path')
    .eq('owner_id', admin.id);
  if (mediaError) throw mediaError;
  const paths = [...new Set((media ?? []).flatMap((asset: {
    storage_path: string | null;
    silhouette_storage_path: string | null;
  }) => [asset.storage_path, asset.silhouette_storage_path])
    .filter((path): path is string => Boolean(path)))];
  if (paths.length) {
    const { error } = await supabase.storage.from('reveal-media').remove(paths);
    if (error) throw error;
  }
  const { error: profileError } = await supabase.from('admin_profiles').delete().eq('id', admin.id);
  if (profileError) throw profileError;
}

test.describe.serial('real Pages + Supabase acceptance journeys A–H', () => {
  test.skip(!RUN_REAL, 'Set ACCEPTANCE_REAL=1 plus the exact acknowledged Pages hostname to run destructive real-backend acceptance.');
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    validateRemoteOptIn();
    await writePortraitFixtures();
  });

  test.afterAll(async () => {
    try { await cleanupExactTestData(); }
    finally { if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }); }
  });

  test('Journey A — a clean admin creates, previews, saves, hosts, joins, and completes a varying-choice game', async ({ page, browser }, testInfo) => {
    const dialogs = recordDialogs(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goto(page, '/host');
    await expect(page.getByRole('heading', { name: 'Pick the next mystery.' })).toBeVisible({ timeout: ACTION_TIMEOUT });
    admin = await readLocalStorage<AdminIdentity>(page, 'name-that:admin');
    await expect(page.locator('.game-poster')).toHaveCount(0);
    await page.getByRole('link', { name: /Create new game/ }).click();
    await expect(page.getByRole('heading', { name: 'Build the mystery' })).toBeVisible();
    await page.getByLabel('Game name').fill(GAME_NAME);
    await setQuestion(page, {
      prompt: 'Who keeps the launch train on the rails?',
      revealName: 'Alexandria Montgomery-Rivera',
      funFact: 'Has visited 17 countries and never misses a launch-day playlist.',
      choices: ['Alexandria Montgomery-Rivera', 'Morgan Hale', 'Sam Okafor'],
      correct: 0,
      mysteryImage: mysteryWide,
      revealImage: revealWide,
    });
    await page.getByRole('button', { name: /Add question/ }).click();
    await setQuestion(page, {
      prompt: 'Who turns customer puzzles into clear plans?',
      revealName: 'Bo Li',
      funFact: 'Can solve a Rubik’s Cube during the walk to lunch.',
      choices: ['Rae Silva', 'Noah West', 'Bo Li', 'Imani Jones', 'Theo Park'],
      correct: 2,
      mysteryImage: mysteryTall,
      revealImage: revealTall,
    });
    await saveGame(page);
    gameId = new URL(page.url()).pathname.split('/')[3] ?? '';
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.question-rail button').filter({ hasText: 'Alexandria Montgomery-Rivera' }).click();
    await expectImageReady(page.getByRole('img', { name: 'Mystery Image preview' }));
    await expectImageReady(page.getByRole('img', { name: 'Reveal Image preview' }));
    await expect(page.getByLabel('Fun Fact (optional)')).toHaveValue('Has visited 17 countries and never misses a launch-day playlist.');
    await page.getByRole('link', { name: /My games/ }).click();
    const card = page.locator('.game-poster').filter({ has: page.getByRole('heading', { name: GAME_NAME, exact: true }) });
    await expect(card.getByText('2 questions', { exact: false })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await card.getByRole('button', { name: /Host now/ }).click();
    await expect(page.getByRole('button', { name: /Start round/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    const host = await captureHost(page);
    const participant = await joinParticipant(browser, host.code, 'Journey A Player');
    const display = await page.context().newPage();
    await goto(display, `/display/${host.code}`);
    await expect(participant.page.getByText(/Welcome, Journey A Player/)).toBeVisible({ timeout: ACTION_TIMEOUT });
    await completeFromLobby(page, 2, participant.page, display, [
      'Has visited 17 countries and never misses a launch-day playlist.',
      'Can solve a Rubik’s Cube during the walk to lunch.',
    ]);
    expect(dialogs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('journey-a-complete.png'), fullPage: true, animations: 'disabled' });
    await display.close();
    await participant.context.close();
  });

  test('Journey B — Play Again creates a clean second room with intact saved content', async ({ page, browser }) => {
    if (!currentHost) throw new Error('Journey A did not produce a host session.');
    await installAdmin(page);
    await installHost(page, currentHost);
    await goto(page, `/host/${currentHost.code}`);
    await expect(page.getByRole('button', { name: /Play again/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    const previousCode = currentHost.code;
    await page.getByRole('button', { name: /Play again/ }).click();
    await expect(page.getByRole('button', { name: /Start round/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    const replay = await captureHost(page);
    expect(replay.code).not.toBe(previousCode);
    expect(replay.gameId).toBe(gameId);
    await expect(page.locator('.control-metrics article').nth(0)).toContainText('0Players');
    await expect(page.locator('.control-metrics article').nth(1)).toContainText('0/0Eligible answers');
    await expect(page.getByText('Round 1 of 2')).toHaveCount(0);
    const participant = await joinParticipant(browser, replay.code, 'Replay Player');
    await completeFromLobby(page, 2, participant.page);
    await participant.context.close();
  });

  test('Play Again crypto — ciphertext is cacheable but reveal keys are unique and isolated per session', async ({ page }) => {
    // A and B snapshot the same saved game. Session-derived AES material must
    // prevent a revealed key from A unlocking B's already-preloaded ciphertext.
    const a = await createHostViaApi(page);
    await apiHostAction(page, a, 'start');
    const aOpen = await snapshotViaApi(page, a.code);
    const aAsset = liveAsset(aOpen, 'reveal-encrypted');
    const aCached = await fetchPreloadUntilHit(page, new URL(aAsset.url, origin).href);
    expect(aCached.response.ok()).toBe(true);
    expect(aCached.response.headers()['x-preload-key']).toBe(aAsset.key);
    const aCiphertext = await aCached.response.body();
    const aChoice = (aOpen.choices as Array<{ id: string }>)[0];
    if (!aChoice) throw new Error('Session A has no choice.');
    expect((await revealKeyViaApi(page, a.code, aChoice.id)).status()).toBe(404);
    await apiHostAction(page, a, 'lock');
    await apiHostAction(page, a, 'reveal');
    const aReveal = await snapshotViaApi(page, a.code);
    const aCorrect = (aReveal.revealedEmployee as { id?: unknown })?.id;
    if (typeof aCorrect !== 'string') throw new Error('Session A reveal has no correct choice.');
    const aKeyResponse = await revealKeyViaApi(page, a.code, aCorrect);
    expect(aKeyResponse.ok()).toBe(true);
    const aKey = await aKeyResponse.json() as LiveRevealKey;
    expect((await decryptLiveReveal(exactArrayBuffer(aCiphertext), aKey)).byteLength).toBeGreaterThan(0);
    // Finish A, then use the product's Play Again path for B.
    await apiHostAction(page, a, 'show_results');
    await apiHostAction(page, a, 'next_round');
    await apiHostAction(page, a, 'lock');
    await apiHostAction(page, a, 'reveal');
    await apiHostAction(page, a, 'show_results');
    await apiHostAction(page, a, 'show_leaderboard');
    await apiHostAction(page, a, 'end');
    completedCodes.add(a.code);
    const b = await createReplayViaApi(page, a);
    await apiHostAction(page, b, 'start');
    const bOpen = await snapshotViaApi(page, b.code);
    const bAsset = liveAsset(bOpen, 'reveal-encrypted');
    expect(bAsset.url).not.toBe(aAsset.url);
    const bCached = await fetchPreloadUntilHit(page, new URL(bAsset.url, origin).href);
    expect(bCached.response.ok()).toBe(true);
    expect(bCached.response.headers()['x-preload-key']).toBe(bAsset.key);
    const bCiphertext = await bCached.response.body();
    expect(Buffer.compare(aCiphertext, bCiphertext)).not.toBe(0);
    const bChoice = (bOpen.choices as Array<{ id: string }>)[0];
    if (!bChoice) throw new Error('Session B has no choice.');
    expect((await revealKeyViaApi(page, b.code, bChoice.id)).status()).toBe(404);
    await expect(decryptLiveReveal(exactArrayBuffer(bCiphertext), aKey)).rejects.toThrow();

    await apiHostAction(page, b, 'lock');
    await apiHostAction(page, b, 'reveal');
    const bReveal = await snapshotViaApi(page, b.code);
    const bCorrect = (bReveal.revealedEmployee as { id?: unknown })?.id;
    if (typeof bCorrect !== 'string') throw new Error('Session B reveal has no correct choice.');
    const bKeyResponse = await revealKeyViaApi(page, b.code, bCorrect);
    expect(bKeyResponse.ok()).toBe(true);
    const bKey = await bKeyResponse.json() as LiveRevealKey;
    expect(bKey.key).not.toBe(aKey.key);
    expect(bKey.iv).not.toBe(aKey.iv);
    expect((await decryptLiveReveal(exactArrayBuffer(bCiphertext), bKey)).byteLength).toBeGreaterThan(0);
  });

  test('Journeys C and H — the same saved game hosts and completes a third isolated session from the library', async ({ page }) => {
    const host = await createHostFromLibrary(page, GAME_NAME);
    expect([...createdCodes].filter((code) => code === host.code)).toHaveLength(1);
    await expect(page.locator('.control-metrics article').nth(0)).toContainText('0Players');
    await expect(page.locator('.control-metrics article').nth(1)).toContainText('0/0Eligible answers');
    await completeFromLobby(page, 2);
    expect(createdCodes.size).toBeGreaterThanOrEqual(3);
    expect(completedCodes.size).toBeGreaterThanOrEqual(3);
  });

  test('Journey D — add/remove/reorder/edit/replace persists after reload and is snapshotted into a fresh session', async ({ page }) => {
    await installAdmin(page);
    await goto(page, '/host');
    const card = page.locator('.game-poster').filter({ has: page.getByRole('heading', { name: GAME_NAME, exact: true }) });
    await card.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByLabel('Game name')).toHaveValue(GAME_NAME, { timeout: ACTION_TIMEOUT });
    await page.getByLabel('Game name').fill(EDITED_GAME_NAME);

    await page.getByRole('button', { name: /Add question/ }).click();
    await setQuestion(page, {
      prompt: 'Who brings the clearest demo-day energy?',
      revealName: 'Casey Wu',
      funFact: 'Once hosted a community radio show about delightfully obscure inventions.',
      choices: ['Casey Wu', 'Drew Stone', 'Mina Fox', 'Lee Young'],
      correct: 0,
      mysteryImage: mysterySquare,
      revealImage: revealSquare,
    });

    await page.locator('.question-rail button').filter({ hasText: 'Alexandria Montgomery-Rivera' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.question-rail button').filter({ hasText: 'Alexandria Montgomery-Rivera' })).toHaveCount(0);

    await page.locator('.question-rail button').filter({ hasText: 'Bo Li' }).click();
    await page.getByLabel('Move question down').click();
    await page.getByLabel('Remove answer 5').click();
    await page.getByRole('textbox', { name: 'Answer 2', exact: true }).fill('Zee Alvarez — Customer Success');
    await page.getByLabel('Mark answer 2 correct').check();
    await page.getByLabel('Mystery Image').setInputFiles(mysteryWide);
    await page.getByLabel('Reveal Image').setInputFiles(revealWide);
    await page.getByLabel('Fun Fact (optional)').fill('Edited fact: builds tiny mechanical keyboards for friends.');
    await expectImageReady(page.getByRole('img', { name: 'Mystery Image preview' }));
    await expectImageReady(page.getByRole('img', { name: 'Reveal Image preview' }));
    await saveGame(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Game name')).toHaveValue(EDITED_GAME_NAME, { timeout: ACTION_TIMEOUT });
    const railItems = page.locator('.question-rail > button:not(.add-question)');
    await expect(railItems).toHaveCount(2);
    await expect(railItems.nth(0)).toContainText('Casey Wu');
    await expect(railItems.nth(1)).toContainText('Bo Li');
    await railItems.nth(1).click();
    await expect(page.locator('.answer-row')).toHaveCount(4);
    await expect(page.getByRole('textbox', { name: 'Answer 2', exact: true })).toHaveValue('Zee Alvarez — Customer Success');
    await expect(page.getByLabel('Mark answer 2 correct')).toBeChecked();
    await expectImageReady(page.getByRole('img', { name: 'Mystery Image preview' }));
    await expectImageReady(page.getByRole('img', { name: 'Reveal Image preview' }));
    await expect(page.getByLabel('Fun Fact (optional)')).toHaveValue('Edited fact: builds tiny mechanical keyboards for friends.');

    await page.getByRole('link', { name: /My games/ }).click();
    const editedCard = page.locator('.game-poster').filter({ has: page.getByRole('heading', { name: EDITED_GAME_NAME, exact: true }) });
    await editedCard.getByRole('button', { name: /Host now/ }).click();
    await expect(page.getByRole('button', { name: /Start round/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    const host = await captureHost(page);
    const display = await page.context().newPage();
    await goto(display, `/display/${host.code}`);
    await page.getByRole('button', { name: /Start round/ }).click();
    await expect(display.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await expect(display.locator('.display-choices > div')).toHaveCount(4);
    await display.close();
    await clickHostAction(page, /Lock answers/, /Reveal teammate/);
    await clickHostAction(page, /Reveal teammate/, /Show results/);
    await clickHostAction(page, /Show results/, /Next round/);
    await page.getByRole('button', { name: /Next round/ }).click();
    await clickHostAction(page, /Lock answers/, /Reveal teammate/);
    await clickHostAction(page, /Reveal teammate/, /Show results/);
    await clickHostAction(page, /Show results/, /Show final leaderboard/);
    await clickHostAction(page, /Show final leaderboard/, /Finish game/);
    await page.getByRole('button', { name: /Finish game/ }).click();
    await expect(page.getByRole('button', { name: /Play again/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    completedCodes.add(host.code);
  });

  test('Journeys E, F, and G — every active phase accepts and restores late participants; reveal has no routine dialog', async ({ page, browser }, testInfo) => {
    const dialogs = recordDialogs(page);
    const host = await createHostFromLibrary(page, EDITED_GAME_NAME);
    const participants: ParticipantHandle[] = [];
    try {
      const lobby = await joinParticipant(browser, host.code, 'Lobby Player');
      participants.push(lobby);
      await expect(lobby.page.getByText(/Welcome, Lobby Player/)).toBeVisible({ timeout: ACTION_TIMEOUT });
      await refreshAndSee(lobby.page, /Welcome, Lobby Player/);

      await clickHostAction(page, /Start round/, /Lock answers/);
      await expect(lobby.page.locator('.choice')).toHaveCount(4, { timeout: ACTION_TIMEOUT });
      const open = await joinParticipant(browser, host.code, 'Open Question Player', true);
      participants.push(open);
      await expect(open.page.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await open.page.locator('.choice').nth(1).click();
      await expect(open.page.getByText(/Locked in:/)).toBeVisible();
      await refreshAndSee(open.page, /Locked in:/);

      // One successful late join did not expose the intermittent hydration race.
      // Repeat with entirely fresh browser contexts and require authoritative
      // question content plus a successful answer without any refresh.
      for (let iteration = 1; iteration <= 5; iteration += 1) {
        const repeated = await joinParticipant(browser, host.code, `Repeated Open ${iteration}`);
        participants.push(repeated);
        await expect(repeated.page.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
        await expectImageReady(repeated.page.locator('.portrait-chamber.is-concealed img'));
        await repeated.page.locator('.choice').first().click();
        await expect(repeated.page.getByText(/Locked in:/)).toBeVisible({ timeout: ACTION_TIMEOUT });
      }

      await clickHostAction(page, /Lock answers/, /Reveal teammate/);
      const locked = await joinParticipant(browser, host.code, 'Locked Player');
      participants.push(locked);
      await expect(locked.page.getByText('Voting is closed.')).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expect(locked.page.locator('.choice')).toHaveCount(0);
      await refreshAndSee(locked.page, 'Voting is closed.');

      await clickHostAction(page, /Reveal teammate/, /Show results/);
      expect(dialogs).toEqual([]);
      await expect(lobby.page.getByRole('heading', { name: 'Casey Wu' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      const reveal = await joinParticipant(browser, host.code, 'Reveal Player');
      participants.push(reveal);
      await expect(reveal.page.getByRole('heading', { name: 'Casey Wu' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await refreshAndSee(reveal.page, 'Casey Wu');

      await clickHostAction(page, /Show results/, /Next round/);
      const results = await joinParticipant(browser, host.code, 'Results Player');
      participants.push(results);
      await expect(results.page.getByLabel('Answer results')).toBeVisible({ timeout: ACTION_TIMEOUT });
      await refreshAndSee(results.page, /nailed the mystery/);

      await page.getByRole('button', { name: /Next round/ }).click();
      await expect(page.getByRole('button', { name: /Lock answers/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
      for (const participant of participants) {
        await expect(participant.page.getByRole('heading', { name: 'Who turns customer puzzles into clear plans?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
        await expect(participant.page.locator('.choice')).toHaveCount(4);
      }
      await locked.page.locator('.choice').first().click();
      await expect(locked.page.getByText(/Locked in:/)).toBeVisible();

      await clickHostAction(page, /Lock answers/, /Reveal teammate/);
      await clickHostAction(page, /Reveal teammate/, /Show results/);
      expect(dialogs).toEqual([]);
      await clickHostAction(page, /Show results/, /Show final leaderboard/);
      await clickHostAction(page, /Show final leaderboard/, /Finish game/);
      await page.getByRole('button', { name: /Finish game/ }).click();
      await expect(page.getByRole('button', { name: /Play again/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
      completedCodes.add(host.code);

      const ended = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const endedPage = await ended.newPage();
      await goto(endedPage, `/join/${host.code}`);
      await endedPage.getByLabel('Display name').fill('Too Late Player');
      await endedPage.getByRole('button', { name: /ready/i }).click();
      await expect(endedPage.getByRole('heading', { name: 'This game has ended.' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await endedPage.screenshot({ path: testInfo.outputPath('finished-room-join.png'), fullPage: true, animations: 'disabled' });
      await ended.close();
    } finally {
      await Promise.all(participants.map(({ context }) => context.close()));
    }
  });

  test('Image performance — preload plan is fetched, reveal paints within 500ms, and round two is already prepared', async ({ page, browser }, testInfo) => {
    const host = await createHostFromLibrary(page, EDITED_GAME_NAME);
    const displayContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const participantContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const display = await displayContext.newPage();
    const participant = await participantContext.newPage();
    const displayProbe = observeImagePerformance(display);
    const participantProbe = observeImagePerformance(participant);
    try {
      await emulateLiveEventNetwork(displayContext, display);
      await emulateLiveEventNetwork(participantContext, participant);
      await goto(display, `/display/${host.code}`);
      await goto(participant, `/join/${host.code}`);
      await participant.getByLabel('Display name').fill('Performance Player');
      await participant.getByRole('button', { name: /ready/i }).click();
      await expect(participant).toHaveURL(`${origin}/play/${host.code}`, { timeout: ACTION_TIMEOUT });
      await clickHostAction(page, /Start round/, /Lock answers/);
      await expect(display.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expect(participant.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      const openSnapshot = await display.evaluate(async (code) => {
        const response = await fetch(`/api/rooms/${code}/snapshot`);
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        return (await response.json() as { snapshot: Record<string, unknown> }).snapshot;
      }, host.code);
      await expectPreloadPlanFetched(display, displayProbe, openSnapshot);
      await expectPreloadPlanFetched(participant, participantProbe, openSnapshot);
      expect(preloadDescriptors(openSnapshot).map((asset) => asset.key)).toEqual(expect.arrayContaining([
        `${host.code}:0:mystery`, `${host.code}:0:reveal`, `${host.code}:1:mystery`, `${host.code}:1:reveal`,
      ]));
      await clickHostAction(page, /Lock answers/, /Reveal teammate/);
      await installRevealRenderProbe(display);
      await installRevealRenderProbe(participant);
      const plaintextBefore = [...displayProbe.assets, ...participantProbe.assets]
        .filter((event) => /\/media\//.test(new URL(event.url).pathname)).length;
      const revealClickedAt = Date.now();
      await clickHostAction(page, /Reveal teammate/, /Show results/);
      const [displayTiming, participantTiming] = await Promise.all([
        revealRenderLatency(display, displayProbe, revealClickedAt), revealRenderLatency(participant, participantProbe, revealClickedAt),
      ]);
      expect(displayTiming.latencyMs, JSON.stringify(displayTiming)).toBeLessThanOrEqual(REVEAL_RENDER_TARGET_MS);
      expect(participantTiming.latencyMs, JSON.stringify(participantTiming)).toBeLessThanOrEqual(REVEAL_RENDER_TARGET_MS);
      const displayClickToPaintMs = displayTiming.renderedAt! - revealClickedAt;
      const participantClickToPaintMs = participantTiming.renderedAt! - revealClickedAt;
      expect(displayClickToPaintMs, JSON.stringify({ revealClickedAt, ...displayTiming })).toBeLessThanOrEqual(REVEAL_RENDER_TARGET_MS);
      expect(participantClickToPaintMs, JSON.stringify({ revealClickedAt, ...participantTiming })).toBeLessThanOrEqual(REVEAL_RENDER_TARGET_MS);
      const plaintextAfter = [...displayProbe.assets, ...participantProbe.assets]
        .filter((event) => /\/media\//.test(new URL(event.url).pathname)).length;
      expect(plaintextAfter, 'preloaded decrypt path must not fall back to a cold plaintext portrait request').toBe(plaintextBefore);
      await expectImageReady(display.locator('.portrait-chamber.is-revealed img'));
      await expectImageReady(participant.locator('.portrait-chamber.is-revealed img'));
      await expect(display.getByText('Once hosted a community radio show about delightfully obscure inventions.', { exact: false })).toBeVisible();
      const roundTwoPaths = preloadDescriptors(openSnapshot)
        .filter((asset) => Number(asset.roundIndex) === 1)
        .map((asset) => new URL(String(asset.url), display.url()).href);
      const requestCount = (path: string) => displayProbe.assets.filter((event) => event.type === 'request' && event.url === path).length;
      expect(roundTwoPaths).toHaveLength(2);
      for (const path of roundTwoPaths) expect(requestCount(path), `expected one prepared request before leaderboard: ${path}`).toBe(1);
      await clickHostAction(page, /Show results/, /Show leaderboard/);
      await clickHostAction(page, /Show leaderboard/, /Next round/);
      await expect(display.getByRole('heading', { name: 'Leaderboard' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(1_500);
      for (const path of roundTwoPaths) expect(requestCount(path), `leaderboard must not duplicate preload: ${path}`).toBe(1);
      await installMysteryRenderProbe(display);
      const nextRoundClickedAt = Date.now();
      await page.getByRole('button', { name: /Next round/ }).click();
      await expect(display.getByRole('heading', { name: 'Who turns customer puzzles into clear plans?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expectImageReady(display.locator('.portrait-chamber.is-concealed img'));
      const roundTwoRenderedAt = await expect.poll(() => display.evaluate(() => window.__nameThatMysteryRenderedAt ?? 0), { timeout: 10_000 }).toBeGreaterThan(0).then(() => display.evaluate(() => window.__nameThatMysteryRenderedAt!));
      const roundTwoLatencyMs = roundTwoRenderedAt - nextRoundClickedAt;
      expect(roundTwoLatencyMs, 'next mystery must render from preloaded bytes').toBeLessThanOrEqual(REVEAL_RENDER_TARGET_MS);
      for (const path of roundTwoPaths) expect(requestCount(path), `next round must reuse preload: ${path}`).toBe(1);
      const timingEvidence = {
        targetMs: REVEAL_RENDER_TARGET_MS,
        displayRevealMs: displayTiming.latencyMs,
        participantRevealMs: participantTiming.latencyMs,
        displayClickToPaintMs,
        participantClickToPaintMs,
        roundTwoMysteryMs: roundTwoLatencyMs,
      };
      console.log(`Production image timing: ${JSON.stringify(timingEvidence)}`);
      await testInfo.attach('production-image-timing.json', {
        body: Buffer.from(JSON.stringify(timingEvidence, null, 2)),
        contentType: 'application/json',
      });
      await display.screenshot({ path: testInfo.outputPath('preloaded-round-two-mystery.png'), fullPage: true, animations: 'disabled' });
    } finally {
      displayProbe.stop(); participantProbe.stop();
      await Promise.all([displayContext.close(), participantContext.close()]);
    }
  });

  test('Room URL transition — same-tab lobby→lobby, active→lobby, and finished→active always terminate', async ({ page, browser }) => {
    const hosts: HostIdentity[] = [];
    for (let index = 0; index < 6; index += 1) hosts.push(await createHostViaApi(page));
    const [lobbyA, lobbyB, activeA, lobbyC, finishedA, activeB] = hosts;
    if (!lobbyA || !lobbyB || !activeA || !lobbyC || !finishedA || !activeB) throw new Error('Could not create route test rooms.');
    await apiHostAction(page, activeA, 'start');
    await apiHostAction(page, activeB, 'start');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const participant = await context.newPage();
    try {
      await goto(participant, `/join/${lobbyA.code}`);
      await joinInSameTab(participant, lobbyA.code, 'Route Lobby A');
      await expect(participant.getByText(/Welcome, Route Lobby A/)).toBeVisible({ timeout: ACTION_TIMEOUT });
      await spaNavigate(participant, `/play/${lobbyB.code}`);
      await joinInSameTab(participant, lobbyB.code, 'Route Lobby B');
      await expect(participant.getByText(/Welcome, Route Lobby B/)).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expect(participant.getByText(/Route Lobby A/)).toHaveCount(0);
      await spaNavigate(participant, `/play/${activeA.code}`);
      await joinInSameTab(participant, activeA.code, 'Route Active A');
      await expect(participant.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expectImageReady(participant.locator('.portrait-chamber.is-concealed img'));
      await spaNavigate(participant, `/play/${lobbyC.code}`);
      await joinInSameTab(participant, lobbyC.code, 'Route Lobby C');
      await expect(participant.getByText(/Welcome, Route Lobby C/)).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expect(participant.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toHaveCount(0);
      await spaNavigate(participant, `/play/${finishedA.code}`);
      await joinInSameTab(participant, finishedA.code, 'Route Finished A');
      await finishViaApi(page, finishedA);
      await expect(participant.getByText(/whole crew/i)).toBeVisible({ timeout: ACTION_TIMEOUT });
      await spaNavigate(participant, `/play/${activeB.code}`);
      await joinInSameTab(participant, activeB.code, 'Route Active B');
      await expect(participant.getByRole('heading', { name: 'Who brings the clearest demo-day energy?' })).toBeVisible({ timeout: ACTION_TIMEOUT });
      await expect(participant.locator('.loading')).toHaveCount(0);
    } finally { await context.close(); }
  });

  test('Participant containment — no host navigation and participant bearer is rejected by host APIs', async ({ page, browser }) => {
    const host = await createHostViaApi(page);
    const participant = await joinParticipant(browser, host.code, 'Contained Player');
    try {
      await expect(participant.page.locator('.participant-shell a[href*="/host"], .participant-shell .brand[href]')).toHaveCount(0);
      const identity = await readLocalStorage<ParticipantSession>(participant.page, 'name-that:participant');
      expect(identity.token).toHaveLength(43);
      const games = await participant.page.request.get(`${origin}/api/games`, { headers: { authorization: `Bearer ${identity.token}` } });
      expect(games.status()).toBe(403);
      const mutation = await participant.page.request.post(`${origin}/api/games`, {
        headers: { authorization: `Bearer ${identity.token}` }, data: { name: 'Forbidden', questions: [] },
      });
      expect(mutation.status()).toBe(403);
    } finally { await participant.context.close(); }
  });

  test('Editor stability — scrollbars do not oscillate across desktop, laptop, zoom, and normal edits', async ({ page }) => {
    await installAdmin(page);
    await goto(page, `/host/games/${gameId}/edit`);
    await expect(page.getByRole('heading', { name: 'Build the mystery' })).toBeVisible({ timeout: ACTION_TIMEOUT });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }]) {
      await page.setViewportSize(viewport);
      for (const zoom of ['1', '1.25']) {
        await page.evaluate((value) => document.body.style.setProperty('zoom', value), zoom);
        expectStableEditorLayout(await sampleLayout(page));
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        expectStableEditorLayout(await sampleLayout(page, 750));
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      }
    }
    await page.evaluate(() => document.body.style.removeProperty('zoom'));
    await page.getByLabel('Mystery Image').setInputFiles(mysterySquare);
    await page.getByLabel('Reveal Image').setInputFiles(revealSquare);
    await Promise.all([
      expectImageReady(page.getByRole('img', { name: 'Mystery Image preview' })),
      expectImageReady(page.getByRole('img', { name: 'Reveal Image preview' })),
    ]);
    expectStableEditorLayout(await sampleLayout(page));
    await page.getByRole('button', { name: /Add question/ }).click();
    expectStableEditorLayout(await sampleLayout(page));
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    expectStableEditorLayout(await sampleLayout(page));
  });

  test('Journey H — several browser-created sessions remain distinct, finished snapshots of one saved game', async () => {
    expect(createdCodes.size).toBeGreaterThanOrEqual(5);
    expect(completedCodes.size).toBeGreaterThanOrEqual(5);
    expect(new Set(createdCodes).size).toBe(createdCodes.size);
    const supabase = serviceClient();
    const codes = [...completedCodes];
    const { data, error } = await supabase
      .from('rooms')
      .select('id,code,phase,current_round,game_id,game_revision')
      .in('code', codes);
    if (error) throw error;
    const rows = data as Array<{
      id: string;
      code: string;
      phase: string;
      current_round: number | null;
      game_id: string | null;
      game_revision: number | null;
    }>;
    expect(rows).toHaveLength(codes.length);
    expect(new Set(rows.map((room) => room.id)).size).toBe(codes.length);
    expect(new Set(rows.map((room) => room.game_id))).toEqual(new Set([gameId]));
    expect(rows.every((room) => room.phase === 'complete')).toBe(true);
    expect(rows.every((room) => room.current_round === 1)).toBe(true);
  });
});
