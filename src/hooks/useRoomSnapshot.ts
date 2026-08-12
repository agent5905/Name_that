import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSnapshot, ParticipantSnapshot } from '../domain/game';
import { errorMessage, getSnapshot } from '../lib/api';
import { RealtimeInvalidationGate } from '../lib/realtimeGate';

interface ParticipantAuth { readonly token: string; readonly playerId: string }

export function useRoomSnapshot(code: string, participant?: ParticipantAuth) {
  const participantToken = participant?.token;
  const participantPlayerId = participant?.playerId;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [participantState, setParticipantState] = useState<ParticipantSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const snapshotVersionRef = useRef(-1);
  const broadcastTimerRef = useRef<number | null>(null);
  const invalidationGateRef = useRef(new RealtimeInvalidationGate());
  const refetchRef = useRef<(quiet?: boolean, source?: 'recovery' | 'broadcast') => Promise<void>>(() => Promise.resolve());

  const refetch = useCallback(async (quiet = false, source: 'recovery' | 'broadcast' = 'recovery') => {
    if (inFlightRef.current) {
      if (source === 'recovery') queuedRef.current = true;
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    if (!quiet) setLoading(true);
    try {
      const auth = participantToken && participantPlayerId
        ? { token: participantToken, playerId: participantPlayerId }
        : undefined;
      const payload = await getSnapshot(code, auth, controller.signal);
      setSnapshot(payload.snapshot);
      snapshotVersionRef.current = payload.snapshot.version;
      setParticipantState(payload.participant ?? null);
      setError(null);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(errorMessage(reason));
    } finally {
      inFlightRef.current = false;
      if (!controller.signal.aborted) setLoading(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        window.setTimeout(() => { void refetchRef.current(true, 'recovery'); }, 0);
      }
    }
  }, [code, participantPlayerId, participantToken]);
  refetchRef.current = refetch;

  useEffect(() => {
    void refetch();
    const timer = window.setInterval(() => { void refetch(true); }, 8_000);
    const onOnline = () => { setOffline(false); void refetch(true); };
    const onOffline = () => setOffline(true);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refetch(true); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);

    let channel: RealtimeChannel | undefined;
    let realtimeClient: SupabaseClient | undefined;
    let cancelled = false;
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (url && key) {
      const initializeRealtime = async () => {
        try {
          const client = createClient(url, key, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
          });
          realtimeClient = client;
          const existing = await client.auth.getSession();
          if (existing.error) throw existing.error;
          let accessToken = existing.data.session?.access_token;
          if (!accessToken) {
            const signedIn = await client.auth.signInAnonymously({
              options: { data: { application: 'name-that-realtime' } },
            });
            if (signedIn.error || !signedIn.data.session) {
              throw signedIn.error ?? new Error('Anonymous Realtime sign-in did not return a session.');
            }
            accessToken = signedIn.data.session.access_token;
          }
          await client.realtime.setAuth(accessToken);
          if (cancelled) return;
          const nextChannel = client.channel(`room:${code}`, { config: { private: true } })
            .on('broadcast', { event: 'room_snapshot_changed' }, ({ payload }) => {
              const broadcastPayload: unknown = payload;
              if (
                typeof broadcastPayload === 'object' && broadcastPayload !== null
                && 'roomCode' in broadcastPayload && broadcastPayload.roomCode === code
                && 'version' in broadcastPayload && typeof broadcastPayload.version === 'number' && Number.isInteger(broadcastPayload.version)
              ) {
                const version = broadcastPayload.version;
                const delay = invalidationGateRef.current.consider(version, snapshotVersionRef.current, Date.now(), inFlightRef.current);
                if (delay === 0) {
                  void refetch(true, 'broadcast');
                } else if (delay !== null && broadcastTimerRef.current === null) {
                  broadcastTimerRef.current = window.setTimeout(() => {
                    broadcastTimerRef.current = null;
                    invalidationGateRef.current.consumeTrailing(Date.now());
                    if (version > snapshotVersionRef.current) void refetchRef.current(true, 'broadcast');
                  }, delay);
                }
              }
            });
          channel = nextChannel;
          nextChannel.subscribe((status) => {
            if (!cancelled && String(status) === 'SUBSCRIBED') void refetchRef.current(true, 'recovery');
          });
        } catch {
          // Realtime is an optimization. Polling, online, and visibility recovery remain active.
          if (channel && realtimeClient) void realtimeClient.removeChannel(channel);
          channel = undefined;
        }
      };
      void initializeRealtime();
    }

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (broadcastTimerRef.current !== null) window.clearTimeout(broadcastTimerRef.current);
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel && realtimeClient) void realtimeClient.removeChannel(channel);
    };
  }, [code, refetch]);

  return { snapshot, participantState, loading, error, offline, refetch, setSnapshot };
}
