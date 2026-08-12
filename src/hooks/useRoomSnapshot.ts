import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSnapshot, ParticipantSnapshot } from '../domain/game';
import { errorMessage, getSnapshot } from '../lib/api';
import { isPriorityPhaseInvalidation, RealtimeInvalidationGate } from '../lib/realtimeGate';
import { parsePushedSnapshot, preserveRevealEnrichment, shouldReplaceSnapshot } from '../lib/snapshot';

interface ParticipantAuth { readonly token: string; readonly playerId: string }

export function useRoomSnapshot(code: string, participant?: ParticipantAuth) {
  const participantToken = participant?.token;
  const participantPlayerId = participant?.playerId;
  const [snapshot, setSnapshotState] = useState<GameSnapshot | null>(null);
  const [participantState, setParticipantState] = useState<ParticipantSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const snapshotVersionRef = useRef(-1);
  const broadcastTimerRef = useRef<number | null>(null);
  const invalidationGateRef = useRef(new RealtimeInvalidationGate());
  const snapshotPhaseRef = useRef<string | null>(null);
  const snapshotRoundRef = useRef<number | null>(null);
  const lastPushedVersionRef = useRef(-1);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const refetchRef = useRef<(quiet?: boolean, source?: 'recovery' | 'broadcast' | 'transition') => Promise<void>>(() => Promise.resolve());

  const applySnapshot = useCallback((next: GameSnapshot, source: 'http' | 'push', nextParticipant?: ParticipantSnapshot | null, updateParticipant = false) => {
    const currentVersion = snapshotVersionRef.current;
    if (!shouldReplaceSnapshot(source, next.version, currentVersion, lastPushedVersionRef.current)) {
      if (updateParticipant && next.roundIndex === snapshotRoundRef.current) setParticipantState(nextParticipant ?? null);
      return false;
    }
    const effective = source === 'http' ? preserveRevealEnrichment(snapshotRef.current, next) : next;
    const roundChanged = effective.roundIndex !== snapshotRoundRef.current;
    setSnapshotState(effective);
    snapshotRef.current = effective;
    snapshotVersionRef.current = effective.version;
    snapshotPhaseRef.current = effective.phase;
    snapshotRoundRef.current = effective.roundIndex;
    if (source === 'push') lastPushedVersionRef.current = effective.version;
    if (source === 'push' && roundChanged && effective.phase === 'question_open') setParticipantState(null);
    else if (updateParticipant) setParticipantState(nextParticipant ?? null);
    setError(null);
    setLoading(false);
    return true;
  }, []);

  const refetch = useCallback(async (quiet = false, source: 'recovery' | 'broadcast' | 'transition' = 'recovery') => {
    if (inFlightRef.current) {
      if (source !== 'broadcast') queuedRef.current = true;
      return;
    }
    const controller = new AbortController();
    const generation = generationRef.current;
    abortRef.current = controller;
    inFlightRef.current = true;
    if (!quiet) setLoading(true);
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const auth = participantToken && participantPlayerId
        ? { token: participantToken, playerId: participantPlayerId }
        : undefined;
      const payload = await getSnapshot(code, auth, controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current) return;
      applySnapshot(payload.snapshot, 'http', payload.participant ?? null, true);
    } catch (reason) {
      if (generation !== generationRef.current) return;
      if (timedOut) setError('The room took too long to respond. Try again.');
      else if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(errorMessage(reason));
    } finally {
      window.clearTimeout(timeout);
      if (generation === generationRef.current && abortRef.current === controller) {
        inFlightRef.current = false;
        setLoading(false);
        if (queuedRef.current) {
          queuedRef.current = false;
          window.setTimeout(() => { void refetchRef.current(true, 'recovery'); }, 0);
        }
      }
    }
  }, [applySnapshot, code, participantPlayerId, participantToken]);
  refetchRef.current = refetch;

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = false;
    queuedRef.current = false;
    snapshotVersionRef.current = -1;
    snapshotPhaseRef.current = null;
    snapshotRoundRef.current = null;
    lastPushedVersionRef.current = -1;
    snapshotRef.current = null;
    invalidationGateRef.current = new RealtimeInvalidationGate();
    setSnapshotState(null);
    setParticipantState(null);
    setError(null);
    setLoading(true);
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
                const phase = 'phase' in broadcastPayload ? broadcastPayload.phase : null;
                const pushed = 'snapshot' in broadcastPayload ? broadcastPayload.snapshot : null;
                const priority = isPriorityPhaseInvalidation(version, snapshotVersionRef.current, phase, snapshotPhaseRef.current)
                  || (version === snapshotVersionRef.current && version !== lastPushedVersionRef.current && pushed !== null);
                if (priority) {
                  if (broadcastTimerRef.current !== null) {
                    window.clearTimeout(broadcastTimerRef.current);
                    broadcastTimerRef.current = null;
                  }
                  invalidationGateRef.current.reset();
                  const next = parsePushedSnapshot(pushed, code, version, phase);
                  if (next) applySnapshot(next, 'push');
                  else void refetch(true, 'transition');
                  return;
                }
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
      generationRef.current += 1;
      abortRef.current?.abort();
      if (broadcastTimerRef.current !== null) window.clearTimeout(broadcastTimerRef.current);
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (channel && realtimeClient) void realtimeClient.removeChannel(channel);
    };
  }, [applySnapshot, code, participantPlayerId, participantToken, refetch]);

  const setSnapshot = useCallback((next: GameSnapshot) => { applySnapshot(next, 'http'); }, [applySnapshot]);
  return { snapshot, participantState, loading, error, offline, refetch, setSnapshot };
}
