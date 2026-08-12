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
try {
  const createdResponse = await fetch(new URL('/api/rooms', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(createdResponse.status, 201, 'The smoke room must be created.');
  const created = await createdResponse.json();
  room = {
    roomId: created.room.roomId,
    code: created.room.code,
    token: created.hostToken,
  };
  await host.addInitScript((session) => {
    localStorage.setItem('name-that:host', JSON.stringify(session));
  }, room);
  await host.goto(new URL(`/host/${room.code}`, baseUrl).href);
  const code = room.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  await host.getByRole('button', { name: /Start round/ }).waitFor();

  const participant = await context.newPage();
  await participant.goto(new URL(`/join/${code}`, baseUrl).href);
  await participant.getByLabel('Display name').fill('Production Smoke Player');
  await participant.getByRole('button', { name: /ready/ }).click();
  await participant.waitForURL(new RegExp(`/play/${code}$`));
  await participant.getByRole('heading', { name: /Welcome, Production Smoke Player/ }).waitFor();

  await host.getByRole('button', { name: /Start round/ }).click();
  await participant.locator('.participant-question').waitFor({ timeout: 15_000 });
  await participant.locator('.choice').first().click();
  await participant.locator('.submitted-banner').waitFor();

  await host.getByRole('button', { name: /Lock answers/ }).click();
  await participant.locator('.participant-wait.locked').waitFor({ timeout: 15_000 });
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
}
