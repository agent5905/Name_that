import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import { deterministicPollJitter, getRealtimeClient, resetRealtimeClientForTests, subscribeToRoom } from './realtimeClient';

describe('realtime browser singleton', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetRealtimeClientForTests();
    createClient.mockReset();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  });

  it('fetches auth once, reuses one client, and stale cleanup cannot close the replacement channel', async () => {
    const channels: Array<{ subscribe: ReturnType<typeof vi.fn> }> = [];
    const removeChannel = vi.fn(() => Promise.resolve('ok'));
    const channel = vi.fn((topic: string, options: unknown) => {
      const built = {
        on: vi.fn(() => built),
        subscribe: vi.fn((callback: (status: string) => void) => { callback('SUBSCRIBED'); return built; }),
        topic,
        options,
      };
      channels.push(built);
      return built;
    });
    const setAuth = vi.fn(() => Promise.resolve());
    createClient.mockReturnValue({ realtime: { setAuth }, channel, removeChannel });
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: 'header.payload.signature' }))));
    vi.stubGlobal('fetch', fetcher);

    const firstClose = await subscribeToRoom('F7K2M', { onBroadcast: vi.fn(), onSubscribed: vi.fn(), onDisconnected: vi.fn() });
    const secondClose = await subscribeToRoom('N8W2Q', { onBroadcast: vi.fn(), onSubscribed: vi.fn(), onDisconnected: vi.fn() });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(setAuth).toHaveBeenCalledWith('header.payload.signature');
    expect(channel).toHaveBeenNthCalledWith(1, 'room:F7K2M', { config: { private: true } });
    expect(channel).toHaveBeenNthCalledWith(2, 'room:N8W2Q', { config: { private: true } });
    expect(removeChannel).toHaveBeenCalledTimes(1);

    firstClose();
    expect(removeChannel).toHaveBeenCalledTimes(1);
    secondClose();
    expect(removeChannel).toHaveBeenCalledTimes(2);
    expect(channels).toHaveLength(2);
  });

  it('clears a subscribed lease and reports an asynchronous channel failure', async () => {
    let statusCallback: ((status: string) => void) | undefined;
    const removeChannel = vi.fn(() => Promise.resolve('ok'));
    const built = {
      on: vi.fn(() => built),
      subscribe: vi.fn((callback: (status: string) => void) => { statusCallback = callback; return built; }),
    };
    createClient.mockReturnValue({
      realtime: { setAuth: vi.fn(() => Promise.resolve()) },
      channel: vi.fn(() => built),
      removeChannel,
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: 'header.payload.signature' })))));
    const disconnected = vi.fn();
    const pending = subscribeToRoom('F7K2M', {
      onBroadcast: vi.fn(), onSubscribed: vi.fn(), onDisconnected: disconnected,
    });
    await vi.waitFor(() => expect(statusCallback).toBeTypeOf('function'));
    statusCallback?.('SUBSCRIBED');
    await expect(pending).resolves.toBeTypeOf('function');
    statusCallback?.('CHANNEL_ERROR');
    expect(disconnected).toHaveBeenCalledWith('CHANNEL_ERROR');
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('rejects and removes a channel when a blocked WebSocket never subscribes', async () => {
    vi.useFakeTimers();
    const removeChannel = vi.fn(() => Promise.resolve('ok'));
    const built = { on: vi.fn(() => built), subscribe: vi.fn(() => built) };
    createClient.mockReturnValue({
      realtime: { setAuth: vi.fn(() => Promise.resolve()) },
      channel: vi.fn(() => built),
      removeChannel,
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: 'header.payload.signature' })))));
    const pending = subscribeToRoom('F7K2M', {
      onBroadcast: vi.fn(), onSubscribed: vi.fn(), onDisconnected: vi.fn(),
    }, 100);
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(removeChannel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('spreads participant safety polls deterministically within the bounded window', () => {
    expect(deterministicPollJitter('F7K2M:player-1')).toBe(deterministicPollJitter('F7K2M:player-1'));
    expect(deterministicPollJitter('F7K2M:player-1')).toBeGreaterThanOrEqual(0);
    expect(deterministicPollJitter('F7K2M:player-1')).toBeLessThanOrEqual(15_000);
    expect(deterministicPollJitter('F7K2M:player-1')).not.toBe(deterministicPollJitter('F7K2M:player-2'));
  });

  it('does not poison the singleton after a transient credential failure', async () => {
    const client = { realtime: { setAuth: vi.fn(() => Promise.resolve()) } };
    createClient.mockReturnValue(client);
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'header.payload.signature' })));
    vi.stubGlobal('fetch', fetcher);
    await expect(getRealtimeClient()).rejects.toThrow('temporary outage');
    await expect(getRealtimeClient()).resolves.toBe(client);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
