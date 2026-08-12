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

function snapshot(phase: string, mediaAvailable = false) {
  return {
    roomCode: code,
    phase,
    roundIndex: phase === 'lobby' ? null : 2,
    roundCount: 3,
    connectedParticipantCount: 18,
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

async function mockGame(page: Page, phase: string, options: { mediaAvailable?: boolean; participantAnswer?: string | null } = {}) {
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
      await route.fulfill({ json: { snapshot: snapshot(phase, options.mediaAvailable), participant: { playerId: ids.player, answerEmployeeId: options.participantAnswer ?? null } } });
      return;
    }
    if (url.pathname.endsWith('/join')) {
      await route.fulfill({ status: 201, json: { participant: { playerId: ids.player, roomId: ids.room, displayName: 'Alex Rivera' }, participantToken: 'x'.repeat(43) } });
      return;
    }
    await route.fulfill({ json: { snapshot: snapshot(phase, options.mediaAvailable) } });
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
  expect((await page.getByRole('link', { name: 'Name That Team Member' }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
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
  expect((await page.getByRole('link', { name: 'Name That Team Member' }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
  await page.getByLabel('Your display name').fill('Alex Rivera');
  await page.screenshot({ path: testInfo.outputPath('participant-join-360.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /Enter game/ }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${code}$`));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('name-that:participant'))).not.toBeNull();
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
  await expect(page.getByText('Correct answer')).toBeVisible();
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
  await expect(page.getByText('Correct answer')).toBeVisible();
  await expect(page.getByText('12 / 18')).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Bring your team together.' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('name-that:host'))).toBeNull();
});

test('display question, locked, and portrait reveal states fit 1280x720', async ({ browser }, testInfo) => {
  for (const [phase, filename] of [
    ['question_open', 'display-question-1280.png'],
    ['answers_locked', 'display-locked-1280.png'],
    ['employee_revealed', 'display-reveal-portrait-1280.png'],
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
