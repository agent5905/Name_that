import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

export interface RoomBroadcast {
  readonly payload: unknown;
}

interface RoomSubscriptionHandlers {
  readonly onBroadcast: (message: RoomBroadcast) => void;
  readonly onSubscribed: () => void;
  readonly onDisconnected: (status: 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED') => void;
}

interface ActiveChannel {
  readonly lease: number;
  readonly channel: RealtimeChannel;
  readonly client: SupabaseClient;
  readonly cancel: () => void;
}

let clientPromise: Promise<SupabaseClient | null> | null = null;
let activeChannel: ActiveChannel | null = null;
let nextLease = 0;

function realtimeToken(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('Realtime credential response was invalid.');
  const record = payload as Record<string, unknown>;
  const token = record.token ?? record.realtimeToken;
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('Realtime credential was invalid.');
  return token;
}

async function initializeClient(): Promise<SupabaseClient | null> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const response = await fetch('/api/realtime-auth', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Realtime credential could not be loaded.');
  const token = realtimeToken(await response.json());
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await client.realtime.setAuth(token);
  return client;
}

/** One credential request and one Supabase browser client for the lifetime of a tab. */
export function getRealtimeClient(): Promise<SupabaseClient | null> {
  clientPromise ??= initializeClient().catch((error: unknown) => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

/**
 * Opens the tab's sole room channel. Replacing a room closes the previous channel,
 * while a stale cleanup lease cannot close a newer subscription.
 */
export async function subscribeToRoom(code: string, handlers: RoomSubscriptionHandlers, timeoutMs = 10_000): Promise<() => void> {
  const client = await getRealtimeClient();
  if (!client) throw new Error('Realtime browser configuration is unavailable.');
  const lease = ++nextLease;
  activeChannel?.cancel();
  const channel = client.channel(`room:${code}`, { config: { private: true } })
    .on('broadcast', { event: 'room_snapshot_changed' }, handlers.onBroadcast);
  let disposed = false;
  let subscribed = false;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let rejectInitial: ((reason: Error) => void) | undefined;
  const terminate = (reason: Error) => {
    if (disposed) return;
    disposed = true;
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    if (activeChannel?.lease === lease) activeChannel = null;
    void client.removeChannel(channel);
    if (!subscribed) rejectInitial?.(reason);
  };
  const cancel = () => terminate(new Error('Realtime subscription was replaced.'));
  activeChannel = { lease, channel, client, cancel };

  return new Promise<() => void>((resolve, reject) => {
    rejectInitial = reject;
    timeout = globalThis.setTimeout(() => {
      if (disposed || subscribed) return;
      terminate(new Error('Realtime subscription timed out.'));
    }, timeoutMs);
    channel.subscribe((rawStatus) => {
      if (disposed || activeChannel?.lease !== lease) return;
      const status = String(rawStatus);
      if (status === 'SUBSCRIBED' && !subscribed) {
        subscribed = true;
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        handlers.onSubscribed();
        resolve(cancel);
        return;
      }
      if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;
      const wasSubscribed = subscribed;
      terminate(new Error(`Realtime subscription failed: ${status}.`));
      if (wasSubscribed) handlers.onDisconnected(status);
    });
  });
}

export function deterministicPollJitter(seed: string, maximumMs = 15_000): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % (maximumMs + 1);
}

export function resetRealtimeClientForTests(): void {
  activeChannel?.cancel();
  activeChannel = null;
  clientPromise = null;
  nextLease = 0;
}
