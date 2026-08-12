import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

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
let widePortrait = '';
let tallPortrait = '';
let squarePortrait = '';
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

function makePortrait(width: number, height: number, base: readonly [number, number, number]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const spotlight = Math.max(0, 1 - Math.hypot(x - width * .5, y - height * .42) / Math.max(width, height));
    png.data[offset] = Math.min(255, Math.round(base[0] + 75 * spotlight));
    png.data[offset + 1] = Math.min(255, Math.round(base[1] + 65 * spotlight));
    png.data[offset + 2] = Math.min(255, Math.round(base[2] + 55 * spotlight));
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function writePortraitFixtures() {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'name-that-acceptance-'));
  widePortrait = join(fixtureDirectory, 'wide-480x220.png');
  tallPortrait = join(fixtureDirectory, 'tall-220x480.png');
  squarePortrait = join(fixtureDirectory, 'square-360x360.png');
  await Promise.all([
    writeFile(widePortrait, makePortrait(480, 220, [18, 88, 154])),
    writeFile(tallPortrait, makePortrait(220, 480, [164, 44, 62])),
    writeFile(squarePortrait, makePortrait(360, 360, [62, 118, 38])),
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
  input: { prompt: string; revealName: string; choices: readonly string[]; correct: number; image: string },
) {
  await page.getByLabel('Question prompt').fill(input.prompt);
  await page.getByLabel('Employee / reveal name').fill(input.revealName);
  const add = page.getByRole('button', { name: /Add answer/ });
  while (await page.locator('.answer-row').count() < input.choices.length) await add.click();
  while (await page.locator('.answer-row').count() > input.choices.length) {
    const count = await page.locator('.answer-row').count();
    await page.getByLabel(`Remove answer ${count}`).click();
  }
  for (const [index, choice] of input.choices.entries()) await page.getByRole('textbox', { name: `Answer ${index + 1}`, exact: true }).fill(choice);
  await page.getByLabel(`Mark answer ${input.correct + 1} correct`).check();
  await page.locator('.image-upload input[type=file]').setInputFiles(input.image);
  await expectImageReady(page.getByRole('img', { name: 'Employee preview' }));
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expectImageReady(page.getByRole('img', { name: `Portrait of ${input.revealName}` }));
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

async function completeFromLobby(page: Page, roundCount: number, participant?: Page) {
  await clickHostAction(page, /Start round/, /Lock answers/);
  for (let round = 0; round < roundCount; round += 1) {
    if (participant) {
      await expect(participant.locator('.choice')).toHaveCount(round === 0 ? 3 : 5, { timeout: ACTION_TIMEOUT });
      await expectImageReady(participant.locator('.portrait-chamber.is-concealed img'));
      await participant.locator('.choice').first().click();
      await expect(participant.getByText(/Locked in:/)).toBeVisible({ timeout: ACTION_TIMEOUT });
    }
    await clickHostAction(page, /Lock answers/, /Reveal teammate/);
    await clickHostAction(page, /Reveal teammate/, /Show results/);
    if (participant) await expectImageReady(participant.locator('.portrait-chamber.is-revealed img'));
    await clickHostAction(page, /Show results/, round === roundCount - 1 ? /Finish game/ : /Next round/);
    if (round === roundCount - 1) {
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
  const paths = (media ?? []).flatMap((asset: { storage_path: string; silhouette_storage_path: string }) =>
    [asset.storage_path, asset.silhouette_storage_path]);
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
      choices: ['Alexandria Montgomery-Rivera', 'Morgan Hale', 'Sam Okafor'],
      correct: 0,
      image: widePortrait,
    });
    await page.getByRole('button', { name: /Add question/ }).click();
    await setQuestion(page, {
      prompt: 'Who turns customer puzzles into clear plans?',
      revealName: 'Bo Li',
      choices: ['Rae Silva', 'Noah West', 'Bo Li', 'Imani Jones', 'Theo Park'],
      correct: 2,
      image: tallPortrait,
    });
    await saveGame(page);
    gameId = new URL(page.url()).pathname.split('/')[3] ?? '';
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByRole('link', { name: /My games/ }).click();
    const card = page.locator('.game-poster').filter({ has: page.getByRole('heading', { name: GAME_NAME, exact: true }) });
    await expect(card.getByText('2 questions', { exact: false })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await card.getByRole('button', { name: /Host now/ }).click();
    await expect(page.getByRole('button', { name: /Start round/ })).toBeVisible({ timeout: ACTION_TIMEOUT });
    const host = await captureHost(page);
    const participant = await joinParticipant(browser, host.code, 'Journey A Player');
    await expect(participant.page.getByText(/Welcome, Journey A Player/)).toBeVisible({ timeout: ACTION_TIMEOUT });
    await completeFromLobby(page, 2, participant.page);
    expect(dialogs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('journey-a-complete.png'), fullPage: true, animations: 'disabled' });
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
      choices: ['Casey Wu', 'Drew Stone', 'Mina Fox', 'Lee Young'],
      correct: 0,
      image: squarePortrait,
    });

    await page.locator('.question-rail button').filter({ hasText: 'Alexandria Montgomery-Rivera' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.question-rail button').filter({ hasText: 'Alexandria Montgomery-Rivera' })).toHaveCount(0);

    await page.locator('.question-rail button').filter({ hasText: 'Bo Li' }).click();
    await page.getByLabel('Move question down').click();
    await page.getByLabel('Remove answer 5').click();
    await page.getByRole('textbox', { name: 'Answer 2', exact: true }).fill('Zee Alvarez — Customer Success');
    await page.getByLabel('Mark answer 2 correct').check();
    await page.locator('.image-upload input[type=file]').setInputFiles(widePortrait);
    await expectImageReady(page.getByRole('img', { name: 'Employee preview' }));
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
    await expectImageReady(page.getByRole('img', { name: 'Employee preview' }));

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
    await clickHostAction(page, /Show results/, /Finish game/);
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
      await clickHostAction(page, /Show results/, /Finish game/);
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
