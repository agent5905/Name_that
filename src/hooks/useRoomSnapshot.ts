import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSnapshot, ParticipantSnapshot } from '../domain/game';
import { errorMessage, getSnapshot } from '../lib/api';
import { isPriorityPhaseInvalidation } from '../lib/realtimeGate';
import { deterministicPollJitter, subscribeToRoom } from '../lib/realtimeClient';
import { mergeCountOnlySnapshot, parsePushedSnapshot, preserveRevealEnrichment, shouldReplaceSnapshot } from '../lib/snapshot';

interface ParticipantAuth { readonly token: string; readonly playerId: string }
export type RoomClientRole = 'participant' | 'host' | 'display';

export function useRoomSnapshot(code: string, participant?: ParticipantAuth, role: RoomClientRole = 'participant') {
  const participantToken = participant?.token;
  const participantPlayerId = participant?.playerId;
  const [snapshot, setSnapshotState] = useState<GameSnapshot | null>(null);
  const [participantState, setParticipantState] = useState<ParticipantSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realtimeWarning, setRealtimeWarning] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const snapshotVersionRef = useRef(-1);
  const snapshotPhaseRef = useRef<string | null>(null);
  const snapshotRoundRef = useRef<number | null>(null);
  const lastPushedVersionRef = useRef(-1);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const stopLiveRef = useRef<(() => void) | null>(null);
  const refetchRef = useRef<(quiet?: boolean, source?: 'recovery' | 'broadcast' | 'transition') => Promise<void>>(() => Promise.resolve());

  const applySnapshot = useCallback((next: GameSnapshot, source: 'http' | 'push', nextParticipant?: ParticipantSnapshot | null, updateParticipant = false) => {
    const currentVersion = snapshotVersionRef.current;
    const countRefresh = source === 'http' && role !== 'participant' ? mergeCountOnlySnapshot(snapshotRef.current, next) : null;
    if (countRefresh) {
      setSnapshotState(countRefresh);
      snapshotRef.current = countRefresh;
      setError(null);
      setLoading(false);
      return true;
    }
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
    if (source === 'push' && roundChanged && effective.phase === 'question_open') {
      setParticipantState((current) => current ? { ...current, answerEmployeeId: null, roundFeedback: null, standing: null } : null);
    }
    else if (updateParticipant) setParticipantState(nextParticipant ?? null);
    setError(null);
    setLoading(false);
    return true;
  }, [role]);

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
    setSnapshotState(null);
    setParticipantState(null);
    setError(null);
    setRealtimeWarning(null);
    setLoading(true);
    void refetch();
    let pollTimer: number | null = null;
    let retryTimer: number | null = null;
    let closeChannel: (() => void) | undefined;
    let cancelled = false;
    let liveStopped = false;
    let initializingRealtime = false;
    let realtimeSubscribed = false;
    let retryAttempt = 0;
    const pollDelay = () => {
      if (role !== 'participant') return 2_000;
      if (!realtimeSubscribed) {
        return 10_000 + deterministicPollJitter(`${code}:${participantPlayerId ?? 'spectator'}:degraded`, 5_000);
      }
      return 60_000 + deterministicPollJitter(`${code}:${participantPlayerId ?? 'spectator'}`);
    };
    const schedulePoll = () => {
      if (cancelled || liveStopped) return;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        void refetchRef.current(true, 'recovery').finally(schedulePoll);
      }, pollDelay());
    };
    const scheduleRealtimeRetry = () => {
      if (cancelled || liveStopped || retryTimer !== null) return;
      const base = Math.min(30_000, 1_000 * (2 ** Math.min(retryAttempt, 5)));
      const delay = base + deterministicPollJitter(
        `${code}:${participantPlayerId ?? role}:realtime-retry:${retryAttempt}`,
        Math.min(1_000, Math.floor(base / 2)),
      );
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void initializeRealtime();
      }, delay);
    };
    const markRealtimeDisconnected = () => {
      if (cancelled || liveStopped) return;
      closeChannel = undefined;
      realtimeSubscribed = false;
      setRealtimeWarning('Live connection interrupted. Using safety updates while reconnecting.');
      schedulePoll();
      scheduleRealtimeRetry();
    };
    async function initializeRealtime() {
      if (initializingRealtime || closeChannel || cancelled || liveStopped) return;
      initializingRealtime = true;
      let subscriptionAlive = true;
      try {
        const close = await subscribeToRoom(code, {
          onBroadcast: ({ payload }) => {
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
                  const next = parsePushedSnapshot(pushed, code, version, phase);
                  if (next) {
                    const applied = applySnapshot(next, 'push');
                    if (applied && participantPlayerId && (next.phase === 'employee_revealed' || next.phase === 'results_displayed' || next.phase === 'leaderboard_displayed' || next.phase === 'complete')) {
                      void refetchRef.current(true, 'transition');
                    }
                  }
                  else void refetch(true, 'transition');
                }
              }
          },
          onSubscribed: () => {
            if (cancelled || liveStopped) return;
            realtimeSubscribed = true;
            retryAttempt = 0;
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            retryTimer = null;
            setRealtimeWarning(null);
            schedulePoll();
            void refetchRef.current(true, 'recovery');
          },
          onDisconnected: () => {
            subscriptionAlive = false;
            markRealtimeDisconnected();
          },
        });
        if (cancelled || liveStopped || !subscriptionAlive) close();
        else closeChannel = close;
      } catch {
        markRealtimeDisconnected();
      } finally {
        initializingRealtime = false;
      }
    }
    const onOnline = () => { setOffline(false); void refetch(true); if (!closeChannel) void initializeRealtime(); };
    const onOffline = () => setOffline(true);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refetch(true);
        if (!closeChannel) void initializeRealtime();
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);

    const stopLive = () => {
      liveStopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      pollTimer = null;
      retryTimer = null;
      closeChannel?.();
      closeChannel = undefined;
    };
    stopLiveRef.current = stopLive;
    schedulePoll();
    void initializeRealtime();

    return () => {
      cancelled = true;
      generationRef.current += 1;
      abortRef.current?.abort();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      stopLive();
      if (stopLiveRef.current === stopLive) stopLiveRef.current = null;
    };
  }, [applySnapshot, code, participantPlayerId, participantToken, refetch, role]);

  useEffect(() => {
    if (snapshot?.phase === 'complete') stopLiveRef.current?.();
  }, [snapshot?.phase]);

  const setSnapshot = useCallback((next: GameSnapshot) => { applySnapshot(next, 'http'); }, [applySnapshot]);
  const markAnswered = useCallback((answerEmployeeId: string, roundIndex: number) => {
    if (!participantPlayerId || snapshotRef.current?.phase !== 'question_open' || snapshotRef.current.roundIndex !== roundIndex) return false;
    setParticipantState((current) => ({
      playerId: participantPlayerId,
      answerEmployeeId,
      totalScore: current?.totalScore ?? 0,
      roundFeedback: null,
      standing: null,
    }));
    return true;
  }, [participantPlayerId]);
  return { snapshot, participantState, loading, error: error ?? realtimeWarning, offline, refetch, setSnapshot, markAnswered };
}
