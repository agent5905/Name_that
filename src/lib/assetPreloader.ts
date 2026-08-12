export interface PreloadAsset {
  readonly key: string;
  readonly kind: 'mystery' | 'reveal-encrypted';
  readonly roundIndex: number;
  readonly url: string;
}

export interface RevealKey {
  readonly key: string;
  readonly iv: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly aad: string;
}

type CacheEntry = { state: 'loading'; promise: Promise<ArrayBuffer | null> } | { state: 'ready'; bytes: ArrayBuffer } | { state: 'failed'; attemptedAt: number };
const cache = new Map<string, CacheEntry>();
const objectUrls = new Map<string, string>();

function validAsset(asset: PreloadAsset): boolean {
  if (!/^[A-HJ-NP-Z2-9]{5}:\d+:(mystery|reveal)$/.test(asset.key) || !Number.isInteger(asset.roundIndex) || asset.roundIndex < 0) return false;
  try {
    const parsed = new URL(asset.url, location.origin);
    return parsed.origin === location.origin && parsed.pathname.startsWith('/api/rooms/');
  } catch { return false; }
}

export function preloadAsset(asset: PreloadAsset): Promise<ArrayBuffer | null> {
  if (!validAsset(asset)) return Promise.resolve(null);
  const existing = cache.get(asset.key);
  if (existing?.state === 'ready') return Promise.resolve(existing.bytes);
  if (existing?.state === 'loading') return existing.promise;
  if (existing?.state === 'failed' && Date.now() - existing.attemptedAt < 2_000) return Promise.resolve(null);
  const promise = fetch(asset.url, { headers: { accept: 'application/octet-stream,image/png' } })
    .then(async (response) => {
      if (!response.ok) throw new Error('preload failed');
      const bytes = await response.arrayBuffer();
      cache.set(asset.key, { state: 'ready', bytes });
      return bytes;
    })
    .catch(() => { cache.set(asset.key, { state: 'failed', attemptedAt: Date.now() }); return null; });
  cache.set(asset.key, { state: 'loading', promise });
  return promise;
}

export function preloadAssets(assets: readonly PreloadAsset[] | null | undefined): void {
  for (const asset of assets ?? []) void preloadAsset(asset);
}

export async function preloadedImageObjectUrl(asset: PreloadAsset, mimeType = 'image/png'): Promise<string | null> {
  const existing = objectUrls.get(asset.key);
  if (existing) return existing;
  const bytes = await preloadAsset(asset);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  objectUrls.set(asset.key, url);
  return url;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function revealObjectUrl(assetKey: string, key: RevealKey, asset?: PreloadAsset): Promise<string | null> {
  const existingUrl = objectUrls.get(assetKey);
  if (existingUrl) return existingUrl;
  const entry = cache.get(assetKey);
  const ciphertext = entry?.state === 'ready' ? entry.bytes : entry?.state === 'loading' ? await entry.promise : asset ? await preloadAsset(asset) : null;
  if (!ciphertext) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', base64UrlBytes(key.key), 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlBytes(key.iv), additionalData: new TextEncoder().encode(key.aad) }, cryptoKey, ciphertext);
    const url = URL.createObjectURL(new Blob([plaintext], { type: key.mimeType }));
    objectUrls.set(assetKey, url);
    return url;
  } catch { return null; }
}

export function resetPreloadCache(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  cache.clear();
}

export function releaseRoomAssets(code: string): void {
  const prefix = `${code}:`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  for (const [key, url] of [...objectUrls]) if (key.startsWith(prefix)) { URL.revokeObjectURL(url); objectUrls.delete(key); }
}
