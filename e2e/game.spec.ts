import { expect, test, type Page, type Route } from '@playwright/test';
import jsQR from 'jsqr';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const code = 'F7K2M';
const ids = {
  room: '11111111-1111-4111-8111-111111111111',
  player: '22222222-2222-4222-8222-222222222222',
  maya: '33333333-3333-4333-8333-333333333333',
  jordan: '44444444-4444-4444-8444-444444444444',
  priya: '55555555-5555-4555-8555-555555555555',
  mateo: '66666666-6666-4666-8666-666666666666',
};

const choices = [
  { id: ids.maya, displayName: 'Maya Chen', position: 0 },
  { id: ids.jordan, displayName: 'Jordan Brooks', position: 1 },
  { id: ids.priya, displayName: 'Priya Shah', position: 2 },
  { id: ids.mateo, displayName: 'Mateo Alvarez', position: 3 },
];

function rasterFixture(width: number, height: number, brightness: number) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const variation = Math.round(28 * Math.sin(x / Math.max(1, width / 8)) * Math.cos(y / Math.max(1, height / 7)));
    const value = Math.max(0, Math.min(255, brightness + variation));
    png.data[offset] = value; png.data[offset + 1] = Math.max(0, value - 5); png.data[offset + 2] = Math.min(255, value + 8); png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function snapshot(phase: string, mediaAvailable = false) {
  return {
    roomCode: code,
    phase,
    roundIndex: phase === 'lobby' ? null : 2,
    roundCount: 3,
    connectedParticipantCount: 18,
    eligibleParticipantCount: 18,
    submittedAnswerCount: phase === 'question_open' ? 12 : 18,
    version: 7,
    choices,
    revealedEmployee: ['employee_revealed', 'results_displayed'].includes(phase)
      ? { id: ids.priya, displayName: 'Priya Shah', team: 'Product Design', funFact: 'I once taught a parrot to say stand-up updates.', mediaAvailable }
      : null,
    results: phase === 'results_displayed'
      ? { totalAnswers: 18, correctAnswers: 11, choices: [{ employeeId: ids.maya, count: 2 }, { employeeId: ids.jordan, count: 3 }, { employeeId: ids.priya, count: 11 }, { employeeId: ids.mateo, count: 2 }] }
      : null,
    updatedAt: '2026-08-11T20:00:00.000Z',
  };
}

async function mockGame(page: Page, phase: string, options: { mediaAvailable?: boolean; participantAnswer?: string | null; eligibleParticipantCount?: number } = {}) {
  await page.route('**/api/rooms/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/media/${ids.priya}`)) {
      await route.fulfill({ path: resolve('content/portraits/priya-shah.webp'), contentType: 'image/webp' });
      return;
    }
    if (url.pathname.endsWith('/host')) {
      await route.fulfill({ json: { host: { roomId: ids.room, code, phase, currentRound: phase === 'lobby' ? null : 2, roundCount: 3, isFinalRound: phase !== 'lobby', correctEmployee: phase === 'lobby' ? null : { id: ids.priya, displayName: 'Priya Shah', team: 'Product Design' }, version: 7 } } });
      return;
    }
    if (url.pathname.endsWith('/snapshot')) {
      await route.fulfill({ json: { snapshot: { ...snapshot(phase, options.mediaAvailable), eligibleParticipantCount: options.eligibleParticipantCount ?? 18 }, participant: { playerId: ids.player, answerEmployeeId: options.participantAnswer ?? null } } });
      return;
    }
    if (url.pathname.endsWith('/join')) {
      await route.fulfill({ status: 201, json: { participant: { playerId: ids.player, roomId: ids.room, displayName: 'Alex Rivera' }, participantToken: 'x'.repeat(43) } });
      return;
    }
    await route.fulfill({ json: { snapshot: { ...snapshot(phase, options.mediaAvailable), eligibleParticipantCount: options.eligibleParticipantCount ?? 18 } } });
  });
}

async function participantSession(page: Page) {
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:participant', JSON.stringify({ code: codeValue, roomId: idValues.room, playerId: idValues.player, displayName: 'Alex Rivera', token: 'x'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
}

test('participant question is clear and touch-safe at 390x844', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await participantSession(page);
  await mockGame(page, 'question_open');
  await page.goto(`/play/${code}`);
  await expect(page.getByRole('heading', { name: 'Who is this team member?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Name That Team Member' })).toHaveCount(0);
  expect((await page.getByLabel('Name That Team Member').boundingBox())?.height).toBeGreaterThanOrEqual(48);
  const answerButtons = page.locator('.choice');
  await expect(answerButtons).toHaveCount(4);
  for (const button of await answerButtons.all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  await page.screenshot({ path: testInfo.outputPath('participant-question-390.png'), fullPage: true, animations: 'disabled' });
  await page.context().setOffline(true);
  await expect(page.getByText(/offline/i)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('participant-offline-390.png'), fullPage: true, animations: 'disabled' });
});

test('join flow fits 360x800 and persists a session', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockGame(page, 'lobby');
  await page.goto(`/join/${code}`);
  await expect(page.getByRole('link', { name: 'Name That Team Member' })).toHaveCount(0);
  expect((await page.getByLabel('Name That Team Member').boundingBox())?.height).toBeGreaterThanOrEqual(48);
  await page.getByLabel('Display name').fill('Alex Rivera');
  await page.screenshot({ path: testInfo.outputPath('participant-join-360.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /I’m ready/ }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${code}$`));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('name-that:participant'))).not.toBeNull();
});

test('same-path room switch joins the new room without leaving its form mounted', async ({ page }) => {
  const roomB = 'N8W2Q';
  await participantSession(page);
  await mockGame(page, 'lobby');
  await page.goto(`/play/${code}`);
  await expect(page.getByText(/Welcome, Alex Rivera/)).toBeVisible();
  await page.evaluate((next) => {
    history.pushState({}, '', `/play/${next}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, roomB);
  await page.getByLabel('Display name').fill('Room B Player');
  await page.getByRole('button', { name: /ready/i }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${roomB}$`));
  await expect(page.getByLabel('Display name')).toHaveCount(0);
  await expect(page.getByText(/Welcome, Alex Rivera/)).toBeVisible();
});

test('lobby display renders a decodable room URL at 1920x1080', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockGame(page, 'lobby');
  await page.goto(`/display/${code}`);
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  const qr = page.locator('.qr');
  await expect(qr.locator('svg')).toBeVisible();
  const png = PNG.sync.read(await qr.screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(decoded?.data).toBe(`http://127.0.0.1:4179/join/${code}`);
  await page.screenshot({ path: testInfo.outputPath('display-lobby-1920.png'), fullPage: true, animations: 'disabled' });
});

test('reveal remains legible when downscaled to 1280x720', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockGame(page, 'results_displayed');
  await page.goto(`/display/${code}`);
  await expect(page.getByRole('heading', { name: 'Priya Shah' })).toBeVisible();
  await expect(page.getByText('11', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Correct/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('display-results-1280.png'), fullPage: true, animations: 'disabled' });
});

test('host sees the private answer and finishes the final round', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
  await mockGame(page, 'results_displayed');
  await page.goto(`/host/${code}`);
  await expect(page.getByText('Host answer')).toBeVisible();
  await expect(page.getByText('Priya Shah').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Finish game/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('host-final-round-1440.png'), fullPage: true, animations: 'disabled' });
});

test('participant submitted and locked states preserve the immutable choice', async ({ browser }, testInfo) => {
  for (const [phase, filename] of [['question_open', 'participant-submitted-390.png'], ['answers_locked', 'participant-locked-390.png']] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await participantSession(page);
    await mockGame(page, phase, { participantAnswer: ids.priya });
    await page.goto(`/play/${code}`);
    await expect(page.getByText(phase === 'question_open' ? /Locked in: Priya Shah/ : /You picked Priya Shah/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true, animations: 'disabled' });
    await page.close();
  }
});

test('participant reveal uses the protected portrait response', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await participantSession(page);
  await mockGame(page, 'employee_revealed', { mediaAvailable: true, participantAnswer: ids.priya });
  await page.goto(`/play/${code}`);
  const portrait = page.getByRole('img', { name: 'Portrait of Priya Shah' });
  await expect(portrait).toBeVisible();
  expect(await portrait.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('participant-reveal-390.png'), fullPage: true, animations: 'disabled' });
});

test('host question control exposes progress, private answer, and guarded next action', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
  await mockGame(page, 'question_open');
  await page.goto(`/host/${code}`);
  await expect(page.getByRole('button', { name: /Lock answers/ })).toBeVisible();
  await expect(page.getByText('Host answer')).toBeVisible();
  await expect(page.getByText('12/18')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('host-question-1440.png'), fullPage: true, animations: 'disabled' });
});

test('host refresh preserves its session across a transient verification failure', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
  let hostAttempts = 0;
  let allowSuccess = false;
  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/host')) {
      hostAttempts += 1;
      if (!allowSuccess) {
        await route.fulfill({ status: 500, json: { error: { code: 'TEMPORARY_FAILURE', message: 'The host service is temporarily unavailable.' } } });
      } else {
        await route.fulfill({ json: { host: { roomId: ids.room, code, phase: 'question_open', currentRound: 0, roundCount: 3, isFinalRound: false, correctEmployee: { id: ids.priya, displayName: 'Priya Shah', team: 'Product Design' }, version: 7 } } });
      }
      return;
    }
    await route.fulfill({ json: { snapshot: snapshot('question_open') } });
  });
  await page.goto(`/host/${code}`);
  await expect(page.getByRole('heading', { name: 'Your host session is still here.' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('name-that:host'))).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath('host-refresh-transient-error-1440.png'), fullPage: true, animations: 'disabled' });
  allowSuccess = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /Lock answers/ })).toBeVisible();
  expect(hostAttempts).toBeGreaterThanOrEqual(2);
});

test('host refresh preserves its session across a network verification failure', async ({ page }) => {
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
  let allowSuccess = false;
  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/host')) {
      if (!allowSuccess) {
        await route.abort('failed');
      } else {
        await route.fulfill({ json: { host: { roomId: ids.room, code, phase: 'question_open', currentRound: 0, roundCount: 3, isFinalRound: false, correctEmployee: { id: ids.priya, displayName: 'Priya Shah', team: 'Product Design' }, version: 7 } } });
      }
      return;
    }
    await route.fulfill({ json: { snapshot: snapshot('question_open') } });
  });
  await page.goto(`/host/${code}`);
  await expect(page.getByRole('heading', { name: 'Your host session is still here.' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('name-that:host'))).not.toBeNull();
  allowSuccess = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /Lock answers/ })).toBeVisible();
});

test('definitive host authorization rejection clears the unusable session', async ({ page }) => {
  await page.addInitScript(({ codeValue, idValues }) => {
    localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) }));
  }, { codeValue: code, idValues: ids });
  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/host')) {
      await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } } });
      return;
    }
    await route.fulfill({ json: { snapshot: snapshot('question_open') } });
  });
  await page.goto(`/host/${code}`);
  await expect(page).toHaveURL(/\/host$/);
  expect(await page.evaluate(() => localStorage.getItem('name-that:host'))).toBeNull();
});

test('display question, locked, and portrait reveal states fit 1280x720', async ({ browser }, testInfo) => {
  for (const [phase, filename] of [
    ['question_open', 'display-question-1280.png'],
    ['answers_locked', 'display-locked-1280.png'],
    ['employee_revealed', 'display-reveal-portrait-1280.png'],
    ['complete', 'display-complete-1280.png'],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await mockGame(page, phase, { mediaAvailable: phase === 'employee_revealed' });
    await page.goto(`/display/${code}`);
    if (phase === 'employee_revealed') {
      const portrait = page.getByRole('img', { name: 'Portrait of Priya Shah' });
      await expect(portrait).toBeVisible();
      expect(await portrait.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(100);
    }
    await expect(page.locator('main')).toHaveJSProperty('scrollHeight', 720);
    await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true, animations: 'disabled' });
    await page.close();
  }
});

test('saved game library reads as a game collection and hosts with an idempotent operation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('name-that:admin', JSON.stringify({ id: 'admin-1', token: 'a'.repeat(43) })));
  let sessionBody: { hostToken?: string; idempotencyKey?: string } | null = null;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sessions')) {
      sessionBody = route.request().postDataJSON() as { hostToken?: string; idempotencyKey?: string };
      await route.fulfill({ json: { room: { roomId: ids.room, code, gameId: 'game-1', gameRevision: 3, gameName: 'Summer Team Ice Breaker' }, hostToken: sessionBody.hostToken } });
      return;
    }
    if (url.pathname.endsWith('/host')) { await route.fulfill({ json: { host: { roomId: ids.room, code, phase: 'lobby', currentRound: null, roundCount: 5, isFinalRound: false, correctEmployee: null, version: 1, gameId: 'game-1', gameName: 'Summer Team Ice Breaker' } } }); return; }
    if (url.pathname.endsWith('/snapshot')) { await route.fulfill({ json: { snapshot: { ...snapshot('lobby'), roundCount: 5 } } }); return; }
    await route.fulfill({ json: { games: [{ id: 'game-1', name: 'Summer Team Ice Breaker', revision: 3, questionCount: 5, updatedAt: '2026-08-11T20:00:00Z' }] } });
  });
  await page.goto('/host');
  await expect(page.getByRole('heading', { name: 'Pick the next mystery.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Summer Team Ice Breaker' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('game-library-1440.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /Host now/ }).click();
  await expect(page).toHaveURL(new RegExp(`/host/${code}$`));
  expect(sessionBody).not.toBeNull();
  expect(sessionBody!.hostToken).toHaveLength(43);
  expect(sessionBody!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test('editor persists separate Mystery and Reveal images plus optional Fun Fact', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('name-that:admin', JSON.stringify({ id: 'admin-1', token: 'a'.repeat(43) })));
  const requests: string[] = [];
  let uploadedMultipart = '';
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/media')) { uploadedMultipart = request.postDataBuffer()?.toString('latin1') ?? ''; await route.fulfill({ json: { media: { id: 'media-1', mysteryMimeType: 'image/png', revealMimeType: 'image/png', mysteryPreviewUrl: '/api/games/game-1/media/media-1?role=mystery', revealPreviewUrl: '/api/games/game-1/media/media-1?role=reveal' } } }); return; }
    if (request.method() === 'POST' && url.pathname === '/api/games') { await route.fulfill({ json: { game: { id: 'game-1', name: 'Summer Team Ice Breaker', revision: 1, questions: [] } } }); return; }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { name: string; questions: Array<Record<string, unknown>> };
      await route.fulfill({ json: { game: { id: 'game-1', name: body.name, revision: 2, questions: body.questions } } }); return;
    }
    await route.fulfill({ json: { games: [] } });
  });
  await page.goto('/host/games/new');
  await page.getByLabel('Game name').fill('Summer Team Ice Breaker');
  await page.getByLabel('Employee / reveal name').fill('Priya Shah');
  await page.getByLabel('Fun Fact (optional)').fill('Has visited 17 countries.');
  await page.getByRole('textbox', { name: 'Answer 1' }).fill('Priya Shah');
  await page.getByRole('textbox', { name: 'Answer 2' }).fill('Maya Chen');
  await page.getByRole('button', { name: /Add answer/ }).click();
  await page.getByRole('textbox', { name: 'Answer 3' }).fill('Jordan Brooks');
  await page.getByLabel('Mystery Image').setInputFiles(resolve('content/portraits/maya-chen.webp'));
  await page.getByLabel('Reveal Image').setInputFiles(resolve('content/portraits/priya-shah.webp'));
  await expect(page.getByRole('img', { name: 'Mystery Image preview' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Reveal Image preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Portrait of Priya Shah' })).toBeVisible();
  await expect(page.locator('.preview-fun-fact')).toHaveText('Has visited 17 countries.');
  await page.screenshot({ path: testInfo.outputPath('game-editor-1600.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /Save game/ }).click();
  await expect.poll(() => requests.join('|')).toContain('PUT /api/games/game-1');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  expect(requests).toEqual(expect.arrayContaining(['POST /api/games', 'POST /api/games/game-1/media', 'PUT /api/games/game-1']));
  expect(uploadedMultipart).toContain('name="mystery"');
  expect(uploadedMultipart).toContain('name="reveal"');
  expect(uploadedMultipart).toContain('filename="priya-shah-normalized.png"');
  expect(uploadedMultipart).toContain('Content-Type: image/png');
  expect(uploadedMultipart).not.toContain('name="silhouette"');
});

test('late joiners do not depress current-round answer progress', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockGame(page, 'question_open', { eligibleParticipantCount: 12 });
  await page.goto(`/display/${code}`);
  await expect(page.getByText('12 / 12')).toBeVisible();
  await expect(page.getByText(/eligible answers locked in/i)).toBeVisible();
});

test('editor previews host-authored mystery and reveal files without transforming either', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => localStorage.setItem('name-that:admin', JSON.stringify({ id: 'admin-1', token: 'a'.repeat(43) })));
  await page.goto('/host/games/new');
  const mystery = rasterFixture(640, 320, 35);
  const reveal = rasterFixture(320, 640, 225);
  await page.getByLabel('Mystery Image').setInputFiles({ name: 'mystery.png', mimeType: 'image/png', buffer: mystery });
  await page.getByLabel('Reveal Image').setInputFiles({ name: 'reveal.png', mimeType: 'image/png', buffer: reveal });
  await expect(page.getByRole('img', { name: 'Mystery Image preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Mystery', exact: true }).click();
  const mysteryPixels = PNG.sync.read(await page.locator('.preview-stage .chamber-photo img').screenshot()).data;
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  const revealPixels = PNG.sync.read(await page.locator('.preview-stage .chamber-photo img').screenshot()).data;
  expect(Buffer.compare(mysteryPixels, revealPixels)).not.toBe(0);
});

test('reveal is immediate and never opens a routine confirmation dialog', async ({ page }) => {
  await page.addInitScript(({ codeValue, idValues }) => localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, token: 'h'.repeat(43) })), { codeValue: code, idValues: ids });
  await mockGame(page, 'answers_locked');
  let dialogs = 0; page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });
  await page.goto(`/host/${code}`);
  await page.getByRole('button', { name: /Reveal teammate/ }).click();
  expect(dialogs).toBe(0);
});

test('play again retries with the same host token and idempotency key', async ({ page }) => {
  await page.addInitScript(({ codeValue, idValues }) => localStorage.setItem('name-that:host', JSON.stringify({ code: codeValue, roomId: idValues.room, gameId: 'game-1', gameName: 'Summer Team Ice Breaker', token: 'h'.repeat(43) })), { codeValue: code, idValues: ids });
  const bodies: Array<{ hostToken: string; idempotencyKey: string }> = [];
  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/host')) { const replayed=url.pathname.includes('N8W2Q');await route.fulfill({ json: { host: { roomId: replayed?'new-room':ids.room, code: replayed?'N8W2Q':code, phase: replayed?'lobby':'complete', currentRound: replayed?null:2, roundCount: 3, isFinalRound: !replayed, correctEmployee: null, version: 9, gameId: 'game-1', gameName: 'Summer Team Ice Breaker' } } }); return; }
    if (url.pathname.endsWith('/snapshot')) { await route.fulfill({ json: { snapshot: snapshot(url.pathname.includes('N8W2Q')?'lobby':'complete') } }); return; }
    if (url.pathname.endsWith('/play-again')) {
      bodies.push(route.request().postDataJSON() as { hostToken: string; idempotencyKey: string });
      if (bodies.length === 1) { await route.fulfill({ status: 500, json: { error: { code: 'TEMPORARY_FAILURE', message: 'Try again.' } } }); return; }
      await route.fulfill({ json: { room: { roomId: 'new-room', code: 'N8W2Q', gameId: 'game-1', gameRevision: 3, gameName: 'Summer Team Ice Breaker' }, hostToken: bodies[1]?.hostToken } }); return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto(`/host/${code}`);
  await page.getByRole('button', { name: /Play again/ }).click();
  await expect(page.getByText('Try again.')).toBeVisible();
  await page.getByRole('button', { name: /Play again/ }).click();
  await expect(page).toHaveURL(/\/host\/N8W2Q$/);
  await expect(page.getByRole('button', { name: /Start round/ })).toBeEnabled();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
});

test('same-tab room transition discards a delayed old-room snapshot and terminates loading', async ({ page }) => {
  const roomB = 'N8W2Q';
  let releaseOld: (() => void) | undefined;
  await page.route('**/api/rooms/**/snapshot', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes(code)) await new Promise<void>((resolvePromise) => { releaseOld = resolvePromise; });
    const roomCode = path.includes(roomB) ? roomB : code;
    await route.fulfill({ json: { snapshot: { ...snapshot('lobby'), roomCode } } });
  });
  await page.goto(`/display/${code}`);
  await expect.poll(() => Boolean(releaseOld)).toBe(true);
  await page.evaluate((next) => { history.pushState({}, '', `/display/${next}`); window.dispatchEvent(new PopStateEvent('popstate')); }, roomB);
  await expect(page.getByText(roomB, { exact: true })).toBeVisible();
  releaseOld?.();
  await page.waitForTimeout(150);
  await expect(page.getByText(roomB, { exact: true })).toBeVisible();
  await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Loading the next scene/i)).toHaveCount(0);
});

test('editor never creates horizontal document overflow while content grows and shrinks', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => localStorage.setItem('name-that:admin', JSON.stringify({ id: 'admin-1', token: 'a'.repeat(43) })));
  await page.goto('/host/games/new');
  const measure = () => page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  for (let index = 0; index < 8; index += 1) await page.getByRole('button', { name: /Add question/ }).click();
  expect((await measure()).scrollWidth).toBeLessThanOrEqual((await measure()).width);
  for (let index = 0; index < 8; index += 1) await page.getByRole('button', { name: 'Remove', exact: true }).click();
  for (let index = 0; index < 8; index += 1) await page.getByRole('button', { name: /Add answer/ }).click();
  const expanded = await measure();
  expect(expanded.scrollWidth).toBeLessThanOrEqual(expanded.width);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)).toBe(true);
});
