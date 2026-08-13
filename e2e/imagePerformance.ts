import { expect, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';

export const REVEAL_RENDER_TARGET_MS = 500;

export interface AssetEvent {
  readonly type: 'request' | 'response' | 'finished';
  readonly url: string;
  readonly at: number;
  readonly status?: number;
  readonly timing?: ReturnType<Request['timing']>;
}

export interface SnapshotEvent {
  readonly phase: string;
  readonly at: number;
  readonly body: Record<string, unknown>;
}

export interface ImagePerformanceProbe {
  readonly assets: AssetEvent[];
  readonly snapshots: SnapshotEvent[];
  stop(): void;
}

const ASSET_PATH = /\/api\/rooms\/[A-HJ-NP-Z2-9]{5}\/(?:mystery(?:-preload)?|reveal-preload|reveal-key|media|assets|preload|image-key)(?:[/?]|$)/;

export function observeImagePerformance(page: Page): ImagePerformanceProbe {
  const assets: AssetEvent[] = [];
  const snapshots: SnapshotEvent[] = [];
  const onRequest = (request: Request) => {
    if (ASSET_PATH.test(new URL(request.url()).pathname)) assets.push({ type: 'request', url: request.url(), at: Date.now() });
  };
  const onFinished = (request: Request) => {
    if (ASSET_PATH.test(new URL(request.url()).pathname)) assets.push({ type: 'finished', url: request.url(), at: Date.now(), timing: request.timing() });
  };
  const onResponse = async (response: Response) => {
    const url = new URL(response.url());
    if (ASSET_PATH.test(url.pathname)) assets.push({ type: 'response', url: response.url(), at: Date.now(), status: response.status() });
    if (!url.pathname.endsWith('/snapshot') || !response.ok()) return;
    const value: unknown = await response.json().catch(() => null);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const body = value as Record<string, unknown>;
    const snapshot = body.snapshot;
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return;
    const phase = (snapshot as Record<string, unknown>).phase;
    if (typeof phase === 'string') snapshots.push({ phase, at: Date.now(), body: snapshot as Record<string, unknown> });
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('response', onResponse);
  return {
    assets,
    snapshots,
    stop() {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('response', onResponse);
    },
  };
}

export function preloadDescriptors(snapshot: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = snapshot.preloadAssets;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
}

function descriptorUrl(descriptor: Record<string, unknown>): string | null {
  return typeof descriptor.url === 'string' ? descriptor.url : null;
}

export async function expectPreloadPlanFetched(page: Page, probe: ImagePerformanceProbe, snapshot: Record<string, unknown>) {
  const descriptors = preloadDescriptors(snapshot);
  expect(descriptors.length, 'question snapshot must advertise current and next-round preload assets').toBeGreaterThanOrEqual(3);
  const urls = descriptors.map(descriptorUrl);
  expect(urls.every(Boolean), 'every preload descriptor must expose its fetch URL').toBe(true);
  for (const path of urls as string[]) {
    const absolute = new URL(path, page.url()).href;
    await expect.poll(
      () => probe.assets.some((event) => event.type === 'finished' && event.url === absolute),
      { timeout: 30_000, message: `expected background preload to finish: ${absolute}` },
    ).toBe(true);
  }
  const rounds = descriptors.map((descriptor) => Number(descriptor.roundIndex));
  const current = Math.min(...rounds);
  const planned = descriptors.map((descriptor) => ({ kind: String(descriptor.kind), round: Number(descriptor.roundIndex) }));
  expect(planned).toContainEqual({ kind: 'mystery', round: current });
  expect(planned).toContainEqual({ kind: 'reveal-encrypted', round: current });
  expect(planned).toContainEqual({ kind: 'mystery', round: current + 1 });
  expect(planned).toContainEqual({ kind: 'reveal-encrypted', round: current + 1 });
}

export async function emulateLiveEventNetwork(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 512_000,
    uploadThroughput: 256_000,
    connectionType: 'cellular3g',
  });
  return cdp;
}

export async function installRevealRenderProbe(page: Page) {
  await page.evaluate(() => {
    type RevealProbe = { domAt?: number; loadedAt?: number; renderedAt?: number };
    const root = window as typeof window & { __nameThatRevealProbe?: RevealProbe };
    root.__nameThatRevealProbe = {};
    const inspect = () => {
      const image = document.querySelector<HTMLImageElement>('.portrait-chamber.is-revealed img');
      if (!image || image.dataset.revealProbe === '1') return;
      image.dataset.revealProbe = '1';
      root.__nameThatRevealProbe!.domAt = Date.now();
      const loaded = () => requestAnimationFrame(() => {
        root.__nameThatRevealProbe!.loadedAt = Date.now();
        requestAnimationFrame(() => { root.__nameThatRevealProbe!.renderedAt = Date.now(); });
      });
      if (image.complete && image.naturalWidth > 0) loaded();
      else image.addEventListener('load', loaded, { once: true });
    };
    new MutationObserver(inspect).observe(document.body, { subtree: true, childList: true, attributes: true });
    inspect();
  });
}

export async function installMysteryRenderProbe(page: Page) {
  await page.evaluate(() => {
    const root = window as typeof window & { __nameThatMysteryRenderedAt?: number };
    delete root.__nameThatMysteryRenderedAt;
    const inspect = () => {
      const image = document.querySelector<HTMLImageElement>('.portrait-chamber.is-concealed img[src^="blob:"]');
      if (!image || image.dataset.mysteryProbe === '1') return;
      image.dataset.mysteryProbe = '1';
      const loaded = () => requestAnimationFrame(() => {
        requestAnimationFrame(() => { root.__nameThatMysteryRenderedAt = Date.now(); });
      });
      if (image.complete && image.naturalWidth > 0) loaded();
      else image.addEventListener('load', loaded, { once: true });
    };
    new MutationObserver(inspect).observe(document.body, { subtree: true, childList: true, attributes: true });
    inspect();
  });
}

export async function revealRenderLatency(page: Page, probe: ImagePerformanceProbe, transitionStartedAt?: number) {
  await expect.poll(
    () => page.evaluate(() => (window as typeof window & { __nameThatRevealProbe?: { renderedAt?: number } }).__nameThatRevealProbe?.renderedAt ?? 0),
    { timeout: 10_000 },
  ).toBeGreaterThan(0);
  const revealedSnapshot = [...probe.snapshots].reverse().find((snapshot) => snapshot.phase === 'employee_revealed');
  expect(revealedSnapshot || transitionStartedAt, 'neither an HTTP reveal snapshot nor the transition start was observed').toBeTruthy();
  const timing = await page.evaluate(() => (window as typeof window & {
    __nameThatRevealProbe?: { domAt?: number; loadedAt?: number; renderedAt?: number };
  }).__nameThatRevealProbe ?? {});
  expect(timing.renderedAt).toBeTruthy();
  return {
    authoritativeSnapshotAt: revealedSnapshot?.at ?? null,
    ...timing,
    latencyMs: timing.renderedAt! - (revealedSnapshot?.at ?? transitionStartedAt!),
  };
}

export interface LayoutSample {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

export async function sampleLayout(page: Page, durationMs = 1_500, intervalMs = 50): Promise<LayoutSample[]> {
  return page.evaluate(async ({ duration, interval }) => {
    const samples: LayoutSample[] = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      const root = document.documentElement;
      samples.push({ clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight });
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return samples;
  }, { duration: durationMs, interval: intervalMs });
}

export function expectStableEditorLayout(samples: readonly LayoutSample[]) {
  expect(samples.length).toBeGreaterThan(10);
  expect(samples.some((sample) => sample.scrollWidth > sample.clientWidth), 'editor must never overflow horizontally').toBe(false);
  const widths = samples.map((sample) => sample.clientWidth);
  expect(Math.max(...widths) - Math.min(...widths), 'editor viewport width must not oscillate as scrollbars flicker').toBeLessThanOrEqual(1);
  const verticalStates = new Set(samples.map((sample) => sample.scrollHeight > sample.clientHeight));
  expect(verticalStates.size, 'vertical scrollbar presence must remain stable while editor is idle').toBe(1);
}

declare global {
  interface Window {
    __nameThatRevealProbe?: { domAt?: number; loadedAt?: number; renderedAt?: number };
    __nameThatMysteryRenderedAt?: number;
  }
}
