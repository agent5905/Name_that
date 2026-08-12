import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const baseUrl = new URL(required('DEPLOYED_BASE_URL'));
assert.equal(baseUrl.protocol, 'https:');
assert.equal(baseUrl.hostname, required('DEPLOYED_EXPECTED_HOST'));
const supabaseUrl = process.env.SUPABASE_URL ?? required('VITE_SUPABASE_URL');
const admin = createClient(supabaseUrl, required('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const host = await context.newPage();
let room;
let authUserId;
try {
  await host.goto(new URL('/host', baseUrl).href);
  await host.getByRole('button', { name: /Create a new game/ }).click();
  await host.waitForURL(/\/host\/[A-HJ-NP-Z2-9]{5}$/);
  const code = host.url().split('/').at(-1);
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  room = await host.evaluate(() => JSON.parse(localStorage.getItem('name-that:host')));
  assert.equal(room.code, code);
  await host.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith('sb-') && key.endsWith('-auth-token')));
  authUserId = await host.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
      const session = JSON.parse(localStorage.getItem(key));
      if (session?.user?.id) return session.user.id;
    }
    return undefined;
  });

  const participant = await context.newPage();
  await participant.goto(new URL(`/join/${code}`, baseUrl).href);
  await participant.getByLabel('Your display name').fill('Production Smoke Player');
  await participant.getByRole('button', { name: /Enter game/ }).click();
  await participant.waitForURL(new RegExp(`/play/${code}$`));
  await participant.getByRole('heading', { name: /Welcome, Production Smoke Player/ }).waitFor();

  await host.getByRole('button', { name: /Start round/ }).click();
  await participant.getByRole('heading', { name: 'Who is this team member?' }).waitFor({ timeout: 15_000 });
  await participant.locator('.choice').first().click();
  await participant.getByText(/Your answer can’t be changed/).waitFor();

  await host.getByRole('button', { name: /Lock answers/ }).click();
  await participant.getByRole('heading', { name: /You picked|Time’s up/ }).waitFor({ timeout: 15_000 });
  host.once('dialog', (dialog) => dialog.accept());
  await host.getByRole('button', { name: /Reveal teammate/ }).click();
  const portrait = participant.getByRole('img', { name: /Portrait of/ });
  await portrait.waitFor({ timeout: 15_000 });
  assert((await portrait.evaluate(async (image) => {
    await image.decode();
    return image.naturalWidth;
  })) > 100);

  await host.getByRole('button', { name: /Show results/ }).click();
  const display = await context.newPage();
  await display.setViewportSize({ width: 1280, height: 720 });
  await display.goto(new URL(`/display/${code}`, baseUrl).href);
  await display.getByLabel('Answer results').waitFor({ timeout: 15_000 });
  const displayPortrait = display.getByRole('img', { name: /Portrait of/ });
  await displayPortrait.waitFor({ timeout: 15_000 });
  assert((await displayPortrait.evaluate(async (image) => {
    await image.decode();
    return image.naturalWidth;
  })) > 100);
  await display.waitForTimeout(900);
  await mkdir('test-results', { recursive: true });
  await display.screenshot({ path: 'test-results/deployed-production.png', fullPage: true });

  console.log(`Deployed browser smoke passed for room ${code} (host, participant, realtime recovery, protected portrait, results, and display).`);
} finally {
  await browser.close();
  if (room) {
    const snapshotCleanup = await admin.from('room_snapshots').delete().eq('room_code', room.code);
    const roomCleanup = await admin.from('rooms').delete().eq('id', room.roomId);
    if (snapshotCleanup.error || roomCleanup.error) process.exitCode = 1;
  }
  if (authUserId) {
    const user = await admin.auth.admin.getUserById(authUserId);
    if (user.data.user?.user_metadata?.application === 'name-that-realtime') {
      const deleted = await admin.auth.admin.deleteUser(authUserId);
      if (deleted.error) process.exitCode = 1;
    }
  }
}
