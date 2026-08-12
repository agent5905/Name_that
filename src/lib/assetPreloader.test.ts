import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadAsset, preloadAssets, preloadedImageObjectUrl, releaseRoomAssets, resetPreloadCache } from './assetPreloader';
import { revealObjectUrl } from './assetPreloader';

describe('asset preloader', () => {
  beforeEach(() => {
    resetPreloadCache();
    vi.stubGlobal('location', new URL('https://name-that.example/play/F7K2M'));
  });

  it('loads each authorized keyed room asset once without blocking callers', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    vi.stubGlobal('fetch', fetcher);
    const asset = { key: 'F7K2M:0:reveal', kind: 'reveal-encrypted' as const, roundIndex: 0, url: '/api/rooms/F7K2M/reveal-preload?round=0' };
    preloadAssets([asset, asset]);
    await expect(preloadAsset(asset)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-origin and malformed preload hints', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(preloadAsset({ key: 'bad', kind: 'mystery', roundIndex: 0, url: 'https://attacker.example/tracker.png' })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('turns a prefetched mystery into a reusable object URL and releases only that room', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))));
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mystery');
    const asset = { key: 'F7K2M:0:mystery', kind: 'mystery' as const, roundIndex: 0, url: '/api/rooms/F7K2M/mystery-preload?round=0' };
    await expect(preloadedImageObjectUrl(asset)).resolves.toBe('blob:mystery');
    releaseRoomAssets('F7K2M');
    expect(revoke).toHaveBeenCalledWith('blob:mystery');
  });

  it('retries a transient failed preload after the bounded backoff', async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetcher);
    const asset = { key: 'F7K2M:0:mystery', kind: 'mystery' as const, roundIndex: 0, url: '/api/rooms/F7K2M/mystery-preload?round=0' };
    await expect(preloadAsset(asset)).resolves.toBeNull();
    await expect(preloadAsset(asset)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(now + 2_001);
    await expect(preloadAsset(asset)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetcher).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('fetches a missing encrypted reveal descriptor before attempting decryption', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    vi.stubGlobal('fetch', fetcher);
    await expect(revealObjectUrl('F7K2M:0:reveal', { key: 'A'.repeat(43), iv: 'B'.repeat(16), mimeType: 'image/png', aad: 'room' }, { key: 'F7K2M:0:reveal', kind: 'reveal-encrypted', roundIndex: 0, url: '/api/rooms/F7K2M/reveal-preload?round=0' })).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('decrypts a prefetched AES-GCM reveal into an image URL', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = 'name-that:test-room:test-question';
    const plaintext = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, plaintext);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(ciphertext))));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reveal');
    const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const asset = { key: 'F7K2M:0:reveal', kind: 'reveal-encrypted' as const, roundIndex: 0, url: '/api/rooms/F7K2M/reveal-preload?round=0' };
    await preloadAsset(asset);
    await expect(revealObjectUrl(asset.key, { key: encode(rawKey), iv: encode(iv), mimeType: 'image/png', aad }, asset)).resolves.toBe('blob:reveal');
  });
});
