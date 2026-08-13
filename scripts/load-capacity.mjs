import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const ALLOWED_STAGES = new Set([5, 25, 100, 175, 225]);
function parseArgs(argv) {
  const values = new Map();
  for (const argument of argv) {
    if (argument === '--execute') values.set('execute', 'true');
    else if (argument === '--browser-observers') values.set('browser-observers', 'true');
    else if (argument === '--help') values.set('help', 'true');
    else if (argument.startsWith('--') && argument.includes('=')) {
      const index = argument.indexOf('=');
      values.set(argument.slice(2, index), argument.slice(index + 1));
    } else throw new Error(`Unknown argument ${argument}. Use --help for supported options.`);
  }
  const integer = (name, fallback, minimum, maximum) => {
    const raw = values.get(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}.`);
    }
    return parsed;
  };
  const number = (name, fallback, minimum, maximum) => {
    const raw = values.get(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`--${name} must be from ${minimum} through ${maximum}.`);
    }
    return parsed;
  };
  const participants = integer('participants', 5, 1, 225);
  if (!ALLOWED_STAGES.has(participants)) {
    throw new Error('--participants must be a scoring-stage value: 5, 25, 100, 175, or 225.');
  }
  return {
    execute: values.get('execute') === 'true',
    browserObservers: values.get('browser-observers') === 'true',
    help: values.get('help') === 'true',
    participants,
    rounds: integer('rounds', 3, 1, 20),
    joinWindowMs: integer('join-window-ms', participants <= 10 ? 2_000 : 30_000, 0, 300_000),
    participantPollMs: integer('participant-poll-ms', 60_000, 15_000, 300_000),
    reconnectPercent: number('reconnect-percent', 10, 0, 100),
    latePercent: number('late-percent', 5, 0, 25),
    lateJoinWindowMs: integer('late-join-window-ms', 5_000, 0, 60_000),
    reconnectOutageMs: integer('reconnect-outage-ms', 3_000, 250, 60_000),
    duplicatePercent: number('duplicate-percent', 10, 0, 100),
    transitionTimeoutMs: integer('transition-timeout-ms', 15_000, 1_000, 60_000),
    answerWindowMs: integer('answer-window-ms', 5_000, 0, 60_000),
    output: values.get('output') ?? '',
  };
}

function usage() {
  return `Name That Team Member protocol capacity harness

Dry-run (default; no network):
  node scripts/load-capacity.mjs --participants=25 --rounds=3

Remote execution additionally requires --execute and all CAPACITY_* acknowledgements:
  node --env-file=.env scripts/load-capacity.mjs --execute --participants=25 --rounds=3 \\
    --join-window-ms=15000 --output=docs/capacity-results/25-client.json

Options:
  --participants=5|25|100|175|225
  --rounds=1..20
  --join-window-ms=0..300000
  --answer-window-ms=0..60000
  --participant-poll-ms=15000..300000 (target client default is 60000 plus deterministic jitter)
  --reconnect-percent=0..100
  --late-percent=0..25 (joins during round 1 question-open; requires at least 2 rounds)
  --late-join-window-ms=0..60000
  --reconnect-outage-ms=250..60000
  --duplicate-percent=0..100
  --transition-timeout-ms=1000..60000
  --output=<path>
  --execute
  --browser-observers (launch one real host Chrome context and one shared-display context)

Execution environment:
  CAPACITY_ORIGIN, CAPACITY_EXPECTED_HOSTNAME, CAPACITY_EXPECTED_SUPABASE_HOSTNAME,
  CAPACITY_GAME_ID, CAPACITY_ADMIN_TOKEN, CAPACITY_GIT_COMMIT, CAPACITY_DEPLOYMENT_ID,
  CAPACITY_ALLOW_REMOTE=1, CAPACITY_ALLOW_REMOTE_DATA=1, CAPACITY_ALLOW_CLIENTS=<stage>,
  VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY

Secrets are read only from the environment and are never included in reports.`;
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 10) / 10;
}

function summarize(values) {
  if (!values.length) return { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  return {
    count: values.length,
    averageMs: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
    p50Ms: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    maxMs: Math.round(Math.max(...values) * 10) / 10,
  };
}

function scoreForElapsed(elapsedMilliseconds) {
  const elapsed = Math.max(0, Math.min(20_000, Number(elapsedMilliseconds)));
  return 750 + Math.floor((250 * (20_000 - elapsed) + 10_000) / 20_000);
}

function leaderboardTransitionCount(rounds) {
  if (rounds <= 0) return 0;
  return rounds === 1 ? 1 : 2;
}

for (const [elapsed, expected] of [[-1, 1000], [0, 1000], [5_000, 938], [10_000, 875], [15_000, 813], [20_000, 750], [60_000, 750]]) {
  if (scoreForElapsed(elapsed) !== expected) throw new Error(`Scoring oracle failed at ${elapsed} ms.`);
}

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const randomToken = () => randomBytes(32).toString('base64url');
const boundedLockRaceCount = (config) => {
  const duplicates = Math.ceil(config.participants * config.duplicatePercent / 100);
  return Math.min(Math.max(1, Math.ceil(config.participants * 0.05)), Math.max(0, config.participants - duplicates), 12);
};

function safeError(error) {
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return String(error);
}

function categoryFor(status, payload, fallback) {
  const code = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
    ? payload.error.code : undefined;
  return code ? String(code) : status ? `HTTP_${status}` : fallback;
}

function estimate(config) {
  const duplicates = Math.ceil(config.participants * config.duplicatePercent / 100);
  const reconnects = Math.min(
    Math.ceil(config.participants * config.reconnectPercent / 100),
    config.participants - boundedLockRaceCount(config),
  );
  const secondsPerRound = (config.answerWindowMs + 4 * 250) / 1_000;
  const estimatedDurationSeconds = Math.ceil(
    config.joinWindowMs / 1_000
    + (config.rounds > 1 ? config.lateJoinWindowMs / 1_000 : 0)
    + config.rounds * secondsPerRound
    + (reconnects ? config.reconnectOutageMs / 1_000 : 0),
  );
  const periodicSnapshots = Math.ceil(config.participants * estimatedDurationSeconds * 1_000 / config.participantPollMs);
  const lateClients = config.rounds > 1 ? Math.ceil(config.participants * config.latePercent / 100) : 0;
  return {
    participants: config.participants,
    rounds: config.rounds,
    estimatedDurationSeconds,
    pagesFunctionRequests: {
      sessionCreate: 1,
      realtimeCredential: config.participants,
      joins: config.participants,
      initialAndSubscribeSnapshots: `between ${config.participants} and ${config.participants * 2}; concurrent recovery fetches are coalesced`,
      periodicSnapshots,
      answers: config.participants * config.rounds,
      duplicateAnswerProbes: duplicates * config.rounds * 2,
      duplicateJoinRetries: duplicates,
      roomFullBoundaryProbe: config.participants === 225 ? 1 : 0,
      samePhaseInvalidationSnapshots: 0,
      personalizedRevealSnapshots: config.participants * config.rounds,
      personalizedLeaderboardSnapshots: config.participants * leaderboardTransitionCount(config.rounds),
      externalHostAndDisplaySafetyPollsNotGenerated: `approximately ${Math.ceil(estimatedDurationSeconds / 2) * 2} at the target 2-second role interval`,
    },
    supabaseRequests: {
      hostPhaseRpcCalls: `${config.rounds * 4 + leaderboardTransitionCount(config.rounds)} before an optional end action when all saved-game rounds are exercised`,
      exactRoomCleanup: 5,
    },
    realtime: {
      websocketConnections: config.participants,
      privateChannels: config.participants,
      browserObserverConnections: config.browserObservers ? 2 : 0,
      phaseBroadcastDeliveriesBeforeOptionalEnd: (config.rounds * 4 + leaderboardTransitionCount(config.rounds)) * config.participants - lateClients,
      optionalEndBroadcastDeliveries: config.participants,
      samePhaseJoinAndAnswerDeliveries: 0,
      baselineBeforeSuppression: `approximately ${Math.round(config.participants * (config.participants + 1) / 2 + config.rounds * config.participants ** 2).toLocaleString()} join/answer deliveries if the previous every-snapshot fan-out were retained`,
    },
    reconnectClients: reconnects,
    answerLockRaceClients: boundedLockRaceCount(config),
    lateJoinClients: lateClients,
    imageRequests: 0,
    note: 'This is a protocol-capacity estimate. Late clients miss the initial start transition, and the optional end broadcast occurs only when every saved-game round is exercised. It deliberately does not download Mystery/Reveal assets or static application bundles.',
  };
}

const HOST_ACTION_LABEL = {
  start: 'Start round', lock: 'Lock answers', reveal: 'Reveal teammate',
  show_results: 'Show results', show_leaderboard: 'Show leaderboard', next_round: 'Next round', end: 'Finish game',
};

async function openBrowserObservers(config, origin, room) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) });
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const displayContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await hostContext.addInitScript(({ session }) => localStorage.setItem('name-that:host', JSON.stringify(session)), {
    session: {
      roomId: room.roomId, code: room.code, token: room.hostToken,
      gameId: room.gameId, gameRevision: room.gameRevision, gameName: room.gameName,
    },
  });
  const hostPage = await hostContext.newPage();
  const displayPage = await displayContext.newPage();
  const report = {
    enabled: true, hostViewport: '1440x900', displayViewport: '1280x720',
    contexts: 2, transitionObservations: [], screenshots: [],
    hostConsoleErrors: 0, displayConsoleErrors: 0, pageErrors: 0,
    expectedRequestAborts: 0, requestFailures: 0, serverResponses: 0,
  };
  hostPage.on('console', (message) => { if (message.type() === 'error') report.hostConsoleErrors += 1; });
  displayPage.on('console', (message) => { if (message.type() === 'error') report.displayConsoleErrors += 1; });
  for (const page of [hostPage, displayPage]) {
    page.on('pageerror', () => { report.pageErrors += 1; });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? '';
      if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(reason)) report.expectedRequestAborts += 1;
      else report.requestFailures += 1;
    });
    page.on('response', (response) => { if (response.status() >= 500) report.serverResponses += 1; });
  }
  await Promise.all([
    hostPage.goto(`${origin}/host/${room.code}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    displayPage.goto(`${origin}/display/${room.code}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
  ]);
  await Promise.all([
    hostPage.getByRole('heading', { name: 'The room is open.' }).waitFor({ timeout: 15_000 }),
    displayPage.locator('.display-state-lobby').waitFor({ timeout: 15_000 }),
  ]);

  const nextLabel = (phase, roundIndex) => phase === 'question_open' ? 'Lock answers'
    : phase === 'answers_locked' ? 'Reveal teammate'
      : phase === 'employee_revealed' ? 'Show results'
        : phase === 'results_displayed' ? (roundIndex === 0 || roundIndex === config.rounds - 1 ? 'Show leaderboard' : 'Next round')
          : phase === 'leaderboard_displayed' ? (roundIndex === config.rounds - 1 ? 'Finish game' : 'Next round')
          : phase === 'complete' ? 'Play again' : 'Start round';
  const imageReady = async () => {
    await displayPage.locator('.portrait-chamber img').evaluate((image) => new Promise((resolvePromise, reject) => {
      const element = image;
      if (element.complete && element.naturalWidth > 0) return resolvePromise(true);
      const timeout = setTimeout(() => reject(new Error('Display image did not decode in time.')), 10_000);
      element.addEventListener('load', () => { clearTimeout(timeout); resolvePromise(true); }, { once: true });
      element.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Display image failed.')); }, { once: true });
    }));
  };
  return {
    report,
    async trigger(action) {
      const locator = hostPage.getByRole('button', { name: new RegExp(`^${HOST_ACTION_LABEL[action]}`) });
      const started = performance.now();
      await locator.click({ timeout: 15_000 });
      return performance.now() - started;
    },
    async observe(phase, roundIndex, startedAt) {
      const hostReady = hostPage.getByRole('button', { name: new RegExp(`^${nextLabel(phase, roundIndex)}`) })
        .waitFor({ timeout: 15_000 }).then(() => performance.now() - startedAt);
      const displayReady = displayPage.locator(`.display-state-${phase}`).waitFor({ timeout: 15_000 })
        .then(() => performance.now() - startedAt);
      const [hostLatencyMs, displayLatencyMs] = await Promise.all([hostReady, displayReady]);
      if (phase === 'question_open' || phase === 'answers_locked' || phase === 'employee_revealed' || phase === 'results_displayed') {
        await imageReady();
      }
      report.transitionObservations.push({ phase, roundIndex, hostLatencyMs, displayLatencyMs });
      if (config.output && roundIndex === 0 && ['question_open', 'employee_revealed', 'results_displayed', 'leaderboard_displayed'].includes(phase)) {
        const path = resolve(dirname(config.output), `${config.participants}-display-${phase}.png`);
        await displayPage.screenshot({ path, animations: 'disabled' });
        report.screenshots.push(path);
      }
      if (config.output && phase === 'complete') {
        const directory = dirname(config.output);
        const hostPath = resolve(directory, `${config.participants}-host-complete.png`);
        const displayPath = resolve(directory, `${config.participants}-display-complete.png`);
        await Promise.all([hostPage.screenshot({ path: hostPath, animations: 'disabled' }), displayPage.screenshot({ path: displayPath, animations: 'disabled' })]);
        report.screenshots.push(hostPath, displayPath);
      }
    },
    async close() { await browser.close(); },
  };
}

function validateExecution(config) {
  const originText = process.env.CAPACITY_ORIGIN ?? '';
  const expectedHostname = process.env.CAPACITY_EXPECTED_HOSTNAME ?? '';
  const supabaseText = process.env.VITE_SUPABASE_URL ?? '';
  const expectedSupabaseHostname = process.env.CAPACITY_EXPECTED_SUPABASE_HOSTNAME ?? '';
  if (!originText || !expectedHostname) throw new Error('CAPACITY_ORIGIN and CAPACITY_EXPECTED_HOSTNAME are required.');
  if (!supabaseText || !expectedSupabaseHostname) {
    throw new Error('VITE_SUPABASE_URL and CAPACITY_EXPECTED_SUPABASE_HOSTNAME are required.');
  }
  const origin = new URL(originText);
  const supabase = new URL(supabaseText);
  const local = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
  const localData = ['localhost', '127.0.0.1', '::1'].includes(supabase.hostname);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('CAPACITY_ORIGIN must be a bare origin without credentials, path, query, or fragment.');
  }
  if ((!local && origin.protocol !== 'https:') || (local && !['http:', 'https:'].includes(origin.protocol))) {
    throw new Error('Remote capacity targets require HTTPS.');
  }
  if (origin.hostname !== expectedHostname) throw new Error('CAPACITY_EXPECTED_HOSTNAME does not match CAPACITY_ORIGIN.');
  if (supabase.hostname !== expectedSupabaseHostname) {
    throw new Error('CAPACITY_EXPECTED_SUPABASE_HOSTNAME does not match VITE_SUPABASE_URL.');
  }
  if (supabase.username || supabase.password || supabase.pathname !== '/' || supabase.search || supabase.hash) {
    throw new Error('VITE_SUPABASE_URL must be a bare origin without credentials, path, query, or fragment.');
  }
  if ((!localData && supabase.protocol !== 'https:') || (localData && !['http:', 'https:'].includes(supabase.protocol))) {
    throw new Error('Remote Supabase targets require HTTPS.');
  }
  if (!local) {
    if (process.env.CAPACITY_ALLOW_REMOTE !== '1') throw new Error('Remote execution requires CAPACITY_ALLOW_REMOTE=1.');
    if (!expectedHostname.endsWith('.pages.dev')) throw new Error('Remote execution is restricted to an explicitly acknowledged Cloudflare Pages hostname.');
  }
  if (!localData && process.env.CAPACITY_ALLOW_REMOTE_DATA !== '1') {
    throw new Error('A remote Supabase target requires CAPACITY_ALLOW_REMOTE_DATA=1.');
  }
  const allowedClients = Number(process.env.CAPACITY_ALLOW_CLIENTS ?? '0');
  if (!Number.isInteger(allowedClients) || allowedClients !== config.participants) {
    throw new Error(`CAPACITY_ALLOW_CLIENTS must exactly equal ${config.participants}.`);
  }
  const required = [
    'CAPACITY_GAME_ID', 'CAPACITY_ADMIN_TOKEN', 'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'CAPACITY_GIT_COMMIT',
    'CAPACITY_DEPLOYMENT_ID',
  ];
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}.`);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(process.env.CAPACITY_GAME_ID)) throw new Error('CAPACITY_GAME_ID must be a UUID.');
  if (!/^[0-9a-f]{40}$/i.test(process.env.CAPACITY_GIT_COMMIT)) throw new Error('CAPACITY_GIT_COMMIT must be a full 40-character commit SHA.');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(process.env.CAPACITY_DEPLOYMENT_ID)) throw new Error('CAPACITY_DEPLOYMENT_ID must be a UUID.');
  return { origin: origin.origin, local };
}

class Metrics {
  startedAt = new Date().toISOString();
  http = { total: 0, pagesFunctions: 0, supabaseClientHttp: 0, supabaseHostRest: 0, cleanup: 0 };
  joinLatencies = [];
  readyLatencies = [];
  answerLatencies = [];
  joins = { attempted: 0, successful: 0, failed: 0, idempotentRetries: 0, retryFailures: 0 };
  answers = { logicalAttempted: 0, httpAttempted: 0, successful: 0, closedAtLock: 0, failed: 0, idempotentDuplicates: 0, immutableDuplicates: 0, duplicateProbeFailures: 0, acceptedByRound: {} };
  realtime = { subscribed: 0, peakSubscribed: 0, inboundEvents: 0, samePhaseEvents: 0, samePhaseSamples: [], invalidEvents: 0, channelErrors: 0, maxChannelsPerClient: 0 };
  reconnect = { attempted: 0, successful: 0, failed: 0, identityRecovered: 0, idempotentResubmits: 0 };
  snapshot = { successful: 0, failed: 0 };
  errors = {};
  transitions = [];
  capacityBoundary = { attempted: 0, rejectedRoomFull: 0, failed: 0 };
  answerLockRace = [];
  scoring = { rounds: [], ledgerRows: 0, expectedTotalPoints: 0, actualTotalPoints: 0, mismatches: 0 };
  leaderboard = { checks: [], personalRankChecks: 0, mismatches: 0 };
  personalHydrationLatencies = [];

  error(category) { this.errors[category] = (this.errors[category] ?? 0) + 1; }
}

class ParticipantClient {
  constructor(index, context) {
    this.index = index;
    this.context = context;
    this.metrics = context.metrics;
    this.currentSnapshot = null;
    this.currentVersion = -1;
    this.inFlightSnapshot = false;
    this.nextInvalidationAllowedAt = 0;
    this.trailingQueued = false;
    this.transitionObservations = new Map();
    this.status = 'NEW';
    this.subscribedCount = 0;
    this.snapshotPromise = null;
    this.closed = false;
  }

  async start() {
    const readyStarted = performance.now();
    const joinStarted = performance.now();
    this.metrics.joins.attempted += 1;
    const joinOperation = { participantToken: randomToken(), idempotencyKey: randomUUID() };
    const displayName = this.index < 2
      ? `Capacity ${this.context.runId} Chris`
      : `Capacity ${this.context.runId} ${String(this.index + 1).padStart(3, '0')}`;
    const joined = await this.context.pagesJson(`/api/rooms/${this.context.room.code}/join`, {
      method: 'POST', body: {
        name: displayName,
        ...joinOperation,
      },
    });
    this.metrics.joinLatencies.push(performance.now() - joinStarted);
    this.metrics.joins.successful += 1;
    this.playerId = joined.participant.playerId;
    this.participantToken = joined.participantToken;
    if (this.participantToken !== joinOperation.participantToken) throw new Error('Join did not return the supplied participant token.');
    if (this.index < this.context.duplicateJoinCount) {
      try {
        const retried = await this.context.pagesJson(`/api/rooms/${this.context.room.code}/join`, {
          method: 'POST', body: {
            name: displayName,
            ...joinOperation,
          },
        });
        if (retried.participant.playerId !== this.playerId || retried.participantToken !== this.participantToken) {
          throw new Error('Join retry changed participant identity.');
        }
        this.metrics.joins.idempotentRetries += 1;
      } catch (error) {
        this.metrics.joins.retryFailures += 1;
        throw error;
      }
    }
    const realtimeAuth = await this.context.pagesJson('/api/realtime-auth');
    this.realtimeToken = realtimeAuth.token ?? realtimeAuth.realtimeToken ?? '';
    if (typeof this.realtimeToken !== 'string' || this.realtimeToken.split('.').length !== 3) {
      throw new Error('Realtime credential endpoint did not return a JWT token.');
    }
    this.client = createClient(this.context.supabaseUrl, this.context.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: this.context.measuredSupabaseFetch },
    });
    const readiness = await Promise.allSettled([this.fetchSnapshot('initial'), this.connectRealtime()]);
    if (readiness[0].status === 'rejected' || readiness[0].value !== true) throw new Error('Initial participant snapshot failed.');
    if (readiness[1].status === 'rejected') throw readiness[1].reason;
    this.metrics.readyLatencies.push(performance.now() - readyStarted);
    this.scheduleSafetyPoll();
  }

  scheduleSafetyPoll() {
    const jitterBucket = ((this.index * 73) % 21) - 10;
    const delay = Math.round(this.context.config.participantPollMs * (1 + jitterBucket / 100));
    this.pollTimer = setTimeout(async () => {
      await this.fetchSnapshot('periodic');
      if (!this.closed) this.scheduleSafetyPoll();
    }, delay);
  }

  async connectRealtime() {
    await this.client.realtime.setAuth(this.realtimeToken);
    this.channel = this.client.channel(`room:${this.context.room.code}`, { config: { private: true } })
      .on('broadcast', { event: 'room_snapshot_changed' }, ({ payload }) => this.onBroadcast(payload));
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime subscription timed out.')), this.context.config.transitionTimeoutMs);
      this.channel.subscribe((status) => {
        this.status = String(status);
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          this.subscribedCount += 1;
          if (!this.isSubscribed) {
            this.isSubscribed = true;
            this.metrics.realtime.subscribed += 1;
            this.metrics.realtime.peakSubscribed = Math.max(this.metrics.realtime.peakSubscribed, this.metrics.realtime.subscribed);
          }
          this.metrics.realtime.maxChannelsPerClient = Math.max(this.metrics.realtime.maxChannelsPerClient, this.client.getChannels().length);
          void this.fetchSnapshot('subscribe-recovery');
          resolvePromise();
        } else if (status === 'CLOSED') {
          if (this.isSubscribed) {
            this.isSubscribed = false;
            this.metrics.realtime.subscribed = Math.max(0, this.metrics.realtime.subscribed - 1);
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.metrics.realtime.channelErrors += 1;
          this.metrics.error(`REALTIME_${status}`);
          clearTimeout(timer);
          reject(new Error(`Realtime subscription failed: ${status}`));
        }
      });
    });
  }

  applySnapshot(snapshot, source) {
    if (!snapshot || snapshot.roomCode !== this.context.room.code || !Number.isInteger(snapshot.version)) return;
    if (snapshot.version < this.currentVersion) return;
    this.currentSnapshot = snapshot;
    this.currentVersion = snapshot.version;
    this.observeTransition(snapshot.phase, snapshot.roundIndex, source);
  }

  observeTransition(phase, roundIndex, source) {
    const active = this.context.activeTransition;
    if (!active || active.phase !== phase || active.roundIndex !== roundIndex || this.transitionObservations.has(active.id)) return;
    this.transitionObservations.set(active.id, { at: performance.now(), source });
  }

  async fetchSnapshot(source) {
    if (!this.playerId) return false;
    if (this.snapshotPromise) return this.snapshotPromise;
    this.inFlightSnapshot = true;
    this.snapshotPromise = (async () => {
      try {
        const payload = await this.context.pagesJson(`/api/rooms/${this.context.room.code}/snapshot`, {
          headers: { authorization: `Bearer ${this.participantToken}`, 'x-player-id': this.playerId },
        });
        this.metrics.snapshot.successful += 1;
        this.participantState = payload.participant ?? null;
        this.applySnapshot(payload.snapshot, source);
        return true;
      } catch {
        this.metrics.snapshot.failed += 1;
        this.metrics.error('SNAPSHOT_FAILED');
        return false;
      } finally {
        this.inFlightSnapshot = false;
        this.snapshotPromise = null;
      }
    })();
    return this.snapshotPromise;
  }

  onBroadcast(payload) {
    this.metrics.realtime.inboundEvents += 1;
    if (!payload || payload.roomCode !== this.context.room.code || !Number.isInteger(payload.version)
      || typeof payload.phase !== 'string') {
      this.metrics.realtime.invalidEvents += 1;
      this.metrics.error('REALTIME_INVALID_EVENT');
      return;
    }
    if (payload.phase === this.currentSnapshot?.phase) {
      this.metrics.realtime.samePhaseEvents += 1;
      if (this.metrics.realtime.samePhaseSamples.length < 20) this.metrics.realtime.samePhaseSamples.push({
        participantIndex: this.index,
        phase: payload.phase,
        roundIndex: payload.snapshot?.roundIndex ?? null,
        payloadVersion: payload.version,
        currentVersion: this.currentVersion,
        currentRoundIndex: this.currentSnapshot?.roundIndex ?? null,
        hasSnapshot: Boolean(payload.snapshot),
        activeTransition: this.context.activeTransition?.id ?? null,
      });
    }
    const priority = payload.version > this.currentVersion && payload.phase !== this.currentSnapshot?.phase;
    if (priority) {
      this.trailingQueued = false;
      this.nextInvalidationAllowedAt = 0;
      if (payload.snapshot) this.applySnapshot(payload.snapshot, 'realtime-push');
      else void this.fetchSnapshot('realtime-transition');
      if (['employee_revealed', 'leaderboard_displayed', 'complete'].includes(payload.phase)) {
        const started = performance.now();
        void this.fetchSnapshot('personalized-transition').then((ok) => {
          if (ok) this.metrics.personalHydrationLatencies.push(performance.now() - started);
        });
      }
      return;
    }
    if (payload.version <= this.currentVersion) return;
    const now = Date.now();
    if (!this.inFlightSnapshot && now >= this.nextInvalidationAllowedAt) {
      this.nextInvalidationAllowedAt = now + 1_000;
      void this.fetchSnapshot('realtime-invalidation');
    } else if (!this.trailingQueued) {
      this.trailingQueued = true;
      this.trailingTimer = setTimeout(() => {
        this.trailingQueued = false;
        this.trailingTimer = undefined;
        this.nextInvalidationAllowedAt = Date.now() + 1_000;
        if (payload.version > this.currentVersion) void this.fetchSnapshot('realtime-trailing');
      }, Math.max(1_000, this.nextInvalidationAllowedAt - now));
    }
  }

  async submitRaw(choiceId, expectedErrors) {
    const started = performance.now();
    this.metrics.answers.httpAttempted += 1;
    const payload = await this.context.pagesJson(`/api/rooms/${this.context.room.code}/answers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.participantToken}` },
        body: { playerId: this.playerId, choiceId, roundIndex: this.currentSnapshot?.roundIndex },
        expectedErrors,
      });
    return { answer: payload.answer, latency: performance.now() - started };
  }

  async answer(choiceId, alternativeChoiceId, probeDuplicates, roundIndex, allowAnswersClosed = false) {
    this.metrics.answers.logicalAttempted += 1;
    try {
      if (!probeDuplicates) {
        const result = await this.submitRaw(choiceId, allowAnswersClosed ? new Set(['ANSWERS_CLOSED']) : undefined);
        this.metrics.answerLatencies.push(result.latency);
        if (result.answer.idempotent) throw new Error('First answer was unexpectedly idempotent.');
      } else {
        const settled = await Promise.allSettled([this.submitRaw(choiceId), this.submitRaw(choiceId)]);
        const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
        const fresh = fulfilled.filter((result) => result.answer.idempotent === false);
        const idempotent = fulfilled.filter((result) => result.answer.idempotent === true);
        if (settled.some((result) => result.status === 'rejected') || fresh.length !== 1 || idempotent.length !== 1) {
          this.metrics.answers.duplicateProbeFailures += 1;
          throw new Error('Concurrent same-choice duplicate was not exactly-once/idempotent.');
        }
        this.metrics.answerLatencies.push(fresh[0].latency);
        this.metrics.answers.idempotentDuplicates += 1;
        if (alternativeChoiceId) {
          try {
            await this.submitRaw(alternativeChoiceId, new Set(['ANSWER_IMMUTABLE']));
            this.metrics.answers.duplicateProbeFailures += 1;
          } catch (error) {
            if (error.category === 'ANSWER_IMMUTABLE') this.metrics.answers.immutableDuplicates += 1;
            else {
              this.metrics.answers.duplicateProbeFailures += 1;
              throw error;
            }
          }
        }
      }
      this.metrics.answers.successful += 1;
      this.metrics.answers.acceptedByRound[roundIndex] = (this.metrics.answers.acceptedByRound[roundIndex] ?? 0) + 1;
      this.lastAnswerChoiceId = choiceId;
      this.answersByRound ??= new Map();
      this.answersByRound.set(roundIndex, choiceId);
      return { outcome: 'accepted' };
    } catch (error) {
      if (allowAnswersClosed && error.category === 'ANSWERS_CLOSED') {
        this.metrics.answers.closedAtLock += 1;
        return { outcome: 'answers_closed' };
      }
      this.metrics.answers.failed += 1;
      throw error;
    }
  }

  async reconnect() {
    this.metrics.reconnect.attempted += 1;
    const before = this.subscribedCount;
    if (this.channel) {
      await this.client.removeChannel(this.channel);
      this.channel = null;
    }
    if (this.isSubscribed) {
      this.isSubscribed = false;
      this.metrics.realtime.subscribed = Math.max(0, this.metrics.realtime.subscribed - 1);
    }
    this.client.realtime.disconnect();
    await sleep(this.context.config.reconnectOutageMs);
    this.client.realtime.connect();
    try {
      // The production hook replaces a terminal room-channel lease. Recreate the
      // channel explicitly instead of relying on a manually closed socket to
      // resurrect a removed subscription implicitly.
      await this.connectRealtime();
    } catch {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_TIMEOUT');
      return false;
    }
    if (this.subscribedCount <= before) {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_TIMEOUT');
      return false;
    }
    if (!(await this.fetchSnapshot('reconnect-recovery'))) {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_SNAPSHOT_FAILED');
      return false;
    }
    if (!this.participantState?.answerEmployeeId || this.participantState.answerEmployeeId !== this.lastAnswerChoiceId) {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_IDENTITY_LOST');
      return false;
    }
    this.metrics.reconnect.identityRecovered += 1;
    let retry;
    try { retry = await this.submitRaw(this.lastAnswerChoiceId); }
    catch {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_RESUBMIT_FAILED');
      return false;
    }
    if (!retry.answer.idempotent) {
      this.metrics.reconnect.failed += 1;
      this.metrics.error('RECONNECT_DUPLICATE_NOT_IDEMPOTENT');
      return false;
    }
    this.metrics.reconnect.idempotentResubmits += 1;
    this.metrics.reconnect.successful += 1;
    return true;
  }

  async close() {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    if (this.snapshotPromise) await this.snapshotPromise;
    if (this.channel && this.client) await this.client.removeChannel(this.channel).catch(() => undefined);
    this.client?.realtime.disconnect();
  }
}

async function run(config, target) {
  const metrics = new Metrics();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const cpuStarted = process.cpuUsage();
  const generator = { peakRssBytes: process.memoryUsage().rss, peakHeapUsedBytes: process.memoryUsage().heapUsed };
  const memoryTimer = setInterval(() => {
    const memory = process.memoryUsage();
    generator.peakRssBytes = Math.max(generator.peakRssBytes, memory.rss);
    generator.peakHeapUsedBytes = Math.max(generator.peakHeapUsedBytes, memory.heapUsed);
  }, 1_000);
  const runId = randomUUID().slice(0, 8);
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const cleanupFetch = async (input, init) => {
    metrics.http.total += 1;
    metrics.http.cleanup += 1;
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  };
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: cleanupFetch },
  });
  const participants = [];
  let room = null;
  let activeTransition = null;
  let browserObservers = null;
  let aborted = false;
  const abort = () => { aborted = true; };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  const measuredSupabaseFetch = async (input, init) => {
    metrics.http.total += 1;
    metrics.http.supabaseClientHttp += 1;
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  };
  const audit = createClient(supabaseUrl, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: measuredSupabaseFetch },
  });
  const pagesJson = async (path, options = {}) => {
    metrics.http.total += 1;
    metrics.http.pagesFunctions += 1;
    const headers = new Headers(options.headers ?? {});
    headers.set('accept', 'application/json');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${target.origin}${path}`, {
      method: options.method ?? 'GET', headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(Math.max(config.transitionTimeoutMs, 30_000)),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const category = categoryFor(response.status, payload, 'NETWORK_ERROR');
      if (!options.expectedErrors?.has(category)) metrics.error(category);
      const error = new Error(`${category} (${response.status})`);
      error.status = response.status;
      error.category = category;
      throw error;
    }
    return payload;
  };
  const context = {
    config, metrics, runId, supabaseUrl, publishableKey, measuredSupabaseFetch,
    correctChoiceByRound: new Map(),
    pagesJson, duplicateJoinCount: Math.ceil(config.participants * config.duplicatePercent / 100),
    get room() { return room; },
    get activeTransition() { return activeTransition; },
  };

  const cleanup = async () => {
    const cleanupErrors = [];
    const closed = await Promise.allSettled(participants.map((participant) => participant.close()));
    for (const result of closed) if (result.status === 'rejected') cleanupErrors.push(`client close: ${safeError(result.reason)}`);
    if (browserObservers) {
      try { await browserObservers.close(); } catch (error) { cleanupErrors.push(`browser close: ${safeError(error)}`); }
    }
    if (room) {
      const read = await admin.from('rooms').select('id,code,game_id').eq('id', room.roomId).maybeSingle();
      if (read.error) cleanupErrors.push(`room guard read: ${read.error.message}`);
      else if (!read.data || read.data.code !== room.code || read.data.game_id !== process.env.CAPACITY_GAME_ID) {
        cleanupErrors.push('Exact room cleanup guard rejected a room identity mismatch.');
      } else {
        const snapshotDelete = await admin.from('room_snapshots').delete().eq('room_code', room.code);
        if (snapshotDelete.error) cleanupErrors.push(`snapshot delete: ${snapshotDelete.error.message}`);
        const roomDelete = await admin.from('rooms').delete().eq('id', room.roomId).eq('code', room.code);
        if (roomDelete.error) cleanupErrors.push(`room delete: ${roomDelete.error.message}`);
        const roomLeft = await admin.from('rooms').select('*', { count: 'exact', head: true }).eq('id', room.roomId);
        const snapshotLeft = await admin.from('room_snapshots').select('*', { count: 'exact', head: true }).eq('room_code', room.code);
        if (roomLeft.error || snapshotLeft.error || roomLeft.count !== 0 || snapshotLeft.count !== 0) {
          cleanupErrors.push('Exact room cleanup verification failed.');
        }
      }
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  };

  const hostAction = async (action, phase, roundIndex) => {
    const id = `${roundIndex}:${phase}`;
    activeTransition = { id, action, phase, roundIndex, started: performance.now() };
    metrics.http.total += 1;
    let hostControlLatencyMs = null;
    if (browserObservers) {
      metrics.http.total -= 1;
      hostControlLatencyMs = await browserObservers.trigger(action);
    } else {
      metrics.http.supabaseHostRest += 1;
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/host_action_direct`, {
        method: 'POST',
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_code: room.code, p_host_token: room.hostToken, p_action: action }),
        signal: AbortSignal.timeout(Math.max(config.transitionTimeoutMs, 30_000)),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const category = categoryFor(response.status, payload, 'HOST_ACTION_FAILED');
        metrics.error(category);
        throw new Error(`${category} (${response.status})`);
      }
    }
    const deadline = Date.now() + config.transitionTimeoutMs;
    while (Date.now() < deadline && participants.some((participant) => !participant.transitionObservations.has(id))) await sleep(25);
    const observations = participants.map((participant) => participant.transitionObservations.get(id)).filter(Boolean);
    const latencies = observations.map(({ at }) => at - activeTransition.started);
    const sourceCounts = {};
    for (const observation of observations) sourceCounts[observation.source] = (sourceCounts[observation.source] ?? 0) + 1;
    metrics.transitions.push({
      action, phase, roundIndex, delivered: observations.length,
      missed: participants.length - observations.length, ...summarize(latencies), sourceCounts,
      ...(hostControlLatencyMs === null ? {} : { hostControlLatencyMs }),
      ...(phase === 'results_displayed' ? {
        answerTotals: [...new Set(participants.map((participant) => participant.currentSnapshot?.results?.totalAnswers ?? null))],
      } : {}),
    });
    if (browserObservers) await browserObservers.observe(phase, roundIndex, activeTransition.started);
    const expectedAnswerTotal = metrics.answers.acceptedByRound[roundIndex] ?? 0;
    if (phase === 'results_displayed' && participants.some((participant) => participant.currentSnapshot?.results?.totalAnswers !== expectedAnswerTotal)) {
      metrics.error('RESULT_TOTAL_MISMATCH');
      activeTransition = null;
      throw new Error(`Clients did not observe the exact authoritative answer total of ${expectedAnswerTotal}.`);
    }
    activeTransition = null;
  };

  const verifyScoring = async (roundIndex, verifyLeaderboard) => {
    const [questionRead, playersRead] = await Promise.all([
      audit.from('session_questions').select('id,position,opened_at').eq('room_id', room.roomId).lte('position', roundIndex).order('position'),
      audit.from('players').select('id,display_name,eligible_from_round,total_score,correct_answer_count,correct_response_ms,current_streak').eq('room_id', room.roomId),
    ]);
    for (const result of [questionRead, playersRead]) if (result.error) throw result.error;
    const questions = questionRead.data ?? [];
    const questionIds = questions.map((question) => question.id);
    const [choicesRead, answersRead] = await Promise.all([
      audit.from('session_choices').select('id,question_id,is_correct').in('question_id', questionIds),
      audit.from('session_answers').select('room_id,question_id,player_id,choice_id,submitted_at,authoritative_elapsed_ms,is_correct,points_awarded,streak_before,streak_after').in('question_id', questionIds),
    ]);
    if (choicesRead.error) throw choicesRead.error;
    if (answersRead.error) throw answersRead.error;
    const positionByQuestion = new Map(questions.map((question) => [question.id, question.position]));
    const correctByQuestion = new Map((choicesRead.data ?? []).filter((choice) => choice.is_correct).map((choice) => [choice.question_id, choice.id]));
    const answers = answersRead.data ?? [];
    const answerByPlayerRound = new Map();
    let expectedRoundPoints = 0;
    let actualRoundPoints = 0;
    let roundRows = 0;
    const openedByQuestion = new Map(questions.map((question) => [question.id, Date.parse(question.opened_at ?? '')]));
    for (const answer of answers) {
      const position = positionByQuestion.get(answer.question_id);
      const expectedCorrect = correctByQuestion.get(answer.question_id) === answer.choice_id;
      const elapsed = Number(answer.authoritative_elapsed_ms);
      const expectedPoints = expectedCorrect ? scoreForElapsed(elapsed) : 0;
      if (!Number.isInteger(elapsed) || elapsed < 0 || elapsed > 86_400_000
        || answer.is_correct !== expectedCorrect || Number(answer.points_awarded) !== expectedPoints) {
        metrics.scoring.mismatches += 1;
        throw new Error(`Authoritative score ledger mismatch for player ${answer.player_id}, round ${position}.`);
      }
      if (position === roundIndex) {
        roundRows += 1;
        expectedRoundPoints += expectedPoints;
        actualRoundPoints += Number(answer.points_awarded);
        const openedAt = openedByQuestion.get(answer.question_id);
        const acceptedAt = Date.parse(answer.submitted_at ?? '');
        if (Number.isFinite(openedAt) && Number.isFinite(acceptedAt)) {
          const timestampElapsed = Math.max(0, Math.min(86_400_000, Math.floor(acceptedAt - openedAt)));
          if (Math.abs(timestampElapsed - elapsed) > 2 || (expectedCorrect && Math.abs(scoreForElapsed(timestampElapsed) - expectedPoints) > 1)) {
            metrics.scoring.mismatches += 1;
            throw new Error(`Accepted/open timestamp oracle mismatch for player ${answer.player_id}, round ${position}.`);
          }
        }
      }
      answerByPlayerRound.set(`${answer.player_id}:${position}`, answer);
    }

    const computed = [];
    for (const player of playersRead.data ?? []) {
      let totalScore = 0;
      let correctAnswers = 0;
      let totalCorrectElapsed = 0;
      let streak = 0;
      for (let position = 0; position <= roundIndex; position += 1) {
        if (position < Number(player.eligible_from_round)) continue;
        const answer = answerByPlayerRound.get(`${player.id}:${position}`);
        if (!answer) { streak = 0; continue; }
        const before = streak;
        streak = answer.is_correct ? streak + 1 : 0;
        if (Number(answer.streak_before) !== before || Number(answer.streak_after) !== streak) {
          metrics.scoring.mismatches += 1;
          throw new Error(`Streak ledger mismatch for player ${player.id}, round ${position}.`);
        }
        totalScore += Number(answer.points_awarded);
        if (answer.is_correct) {
          correctAnswers += 1;
          totalCorrectElapsed += Number(answer.authoritative_elapsed_ms);
        }
      }
      if (Number(player.total_score) !== totalScore || Number(player.correct_answer_count) !== correctAnswers
        || Number(player.correct_response_ms) !== totalCorrectElapsed || Number(player.current_streak) !== streak) {
        metrics.scoring.mismatches += 1;
        throw new Error(`Player scoring aggregate mismatch for ${player.id}.`);
      }
      computed.push({ id: player.id, displayName: player.display_name, totalScore, correctAnswers, totalCorrectElapsed });
    }
    computed.sort((left, right) => right.totalScore - left.totalScore
      || right.correctAnswers - left.correctAnswers
      || left.totalCorrectElapsed - right.totalCorrectElapsed
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const ranked = computed.map((entry, index) => ({ ...entry, rank: index + 1 }));
    const duplicateNames = new Map();
    for (const player of ranked) duplicateNames.set(player.displayName, (duplicateNames.get(player.displayName) ?? 0) + 1);
    if (![...duplicateNames.values()].some((count) => count > 1)) {
      metrics.leaderboard.mismatches += 1;
      throw new Error('Capacity scoring fixture did not preserve duplicate display-name identities.');
    }
    if (roundIndex === config.rounds - 1) {
      const zeroScores = ranked.filter((player) => player.totalScore === 0);
      if (zeroScores.length < 2 || zeroScores.some((player, index) => index > 0 && zeroScores[index - 1].id > player.id)) {
        metrics.leaderboard.mismatches += 1;
        throw new Error('Capacity scoring fixture did not prove deterministic zero-score tie ordering.');
      }
    }
    const expectedAccepted = metrics.answers.acceptedByRound[roundIndex] ?? 0;
    if (roundRows !== expectedAccepted || expectedRoundPoints !== actualRoundPoints) {
      metrics.scoring.mismatches += 1;
      throw new Error(`Round ${roundIndex} scoring totals do not match accepted answers.`);
    }
    metrics.scoring.ledgerRows = answers.length;
    metrics.scoring.expectedTotalPoints = ranked.reduce((sum, player) => sum + player.totalScore, 0);
    metrics.scoring.actualTotalPoints = (playersRead.data ?? []).reduce((sum, player) => sum + Number(player.total_score), 0);
    metrics.scoring.rounds.push({ roundIndex, acceptedAnswers: roundRows, expectedPoints: expectedRoundPoints, actualPoints: actualRoundPoints });

    if (verifyLeaderboard) {
      const board = participants[0]?.currentSnapshot?.leaderboard;
      const expectedTop = ranked.slice(0, roundIndex === config.rounds - 1 ? 10 : 5)
        .map(({ rank, displayName, totalScore, correctAnswers }) => ({ rank, displayName, totalScore, correctAnswers }));
      if (!board || board.isFinal !== (roundIndex === config.rounds - 1)
        || board.entries.length !== expectedTop.length
        || board.entries.some((entry, index) => {
          const expected = expectedTop[index];
          return entry.rank !== expected.rank || entry.displayName !== expected.displayName
            || entry.totalScore !== expected.totalScore || entry.correctAnswers !== expected.correctAnswers;
        })) {
        metrics.leaderboard.mismatches += 1;
        throw new Error(`Public leaderboard mismatch for round ${roundIndex}.`);
      }
      await Promise.all(participants.map(async (participant) => {
        const started = performance.now();
        if (!(await participant.fetchSnapshot('leaderboard-oracle'))) throw new Error('Personal rank hydration failed.');
        metrics.personalHydrationLatencies.push(performance.now() - started);
        const expected = ranked.find((entry) => entry.id === participant.playerId);
        const standing = participant.participantState?.standing;
        if (!expected || !standing || standing.rank !== expected.rank || standing.totalScore !== expected.totalScore
          || participant.participantState.totalScore !== expected.totalScore) {
          metrics.leaderboard.mismatches += 1;
          throw new Error(`Personal rank mismatch for player ${participant.playerId}.`);
        }
        metrics.leaderboard.personalRankChecks += 1;
      }));
      metrics.leaderboard.checks.push({ roundIndex, isFinal: board.isFinal, entries: board.entries });
    }
  };

  let primaryError = null;
  let cleanupError = null;
  try {
    const hostToken = randomToken();
    const created = await pagesJson(`/api/games/${process.env.CAPACITY_GAME_ID}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CAPACITY_ADMIN_TOKEN}` },
      body: { hostToken, idempotencyKey: randomUUID() },
    });
    room = { ...created.room, hostToken: created.hostToken };
    const lobby = await pagesJson(`/api/rooms/${room.code}/snapshot`);
    if (config.rounds > lobby.snapshot.roundCount) {
      throw new Error(`Requested ${config.rounds} rounds, but the saved game has ${lobby.snapshot.roundCount}.`);
    }
    const fixtureQuestions = await audit.from('session_questions').select('id,position').eq('room_id', room.roomId).lt('position', config.rounds);
    if (fixtureQuestions.error) throw fixtureQuestions.error;
    const fixtureChoices = await audit.from('session_choices').select('id,question_id,is_correct').in('question_id', (fixtureQuestions.data ?? []).map((question) => question.id));
    if (fixtureChoices.error) throw fixtureChoices.error;
    const fixturePosition = new Map((fixtureQuestions.data ?? []).map((question) => [question.id, question.position]));
    for (const choice of fixtureChoices.data ?? []) {
      if (choice.is_correct) context.correctChoiceByRound.set(fixturePosition.get(choice.question_id), choice.id);
    }
    if (context.correctChoiceByRound.size !== config.rounds) throw new Error('Capacity fixture must expose exactly one correct choice per exercised round.');
    if (config.browserObservers) {
      browserObservers = await openBrowserObservers(config, target.origin, room);
      // Browser process startup is fixture setup, not load-generator saturation.
      // Reset the loop histogram immediately before the participant ramp.
      eventLoop.reset();
    }

    const lateCount = config.rounds > 1 ? Math.ceil(config.participants * config.latePercent / 100) : 0;
    const initialCount = config.participants - lateCount;
    const startParticipants = async (startIndex, count, windowMs) => {
      const starts = Array.from({ length: count }, (_, offset) => ({
        index: startIndex + offset,
        delay: count === 1 ? 0 : Math.round(offset * windowMs / (count - 1)),
      }));
      await Promise.all(starts.map(async ({ index, delay }) => {
        await sleep(delay + Math.floor(Math.random() * Math.min(250, Math.max(1, windowMs / Math.max(1, count)))));
        if (aborted) throw new Error('Run interrupted.');
        const participant = new ParticipantClient(index, context);
        participants.push(participant);
        try { await participant.start(); }
        catch (error) {
          if (!participant.playerId) metrics.joins.failed += 1;
          metrics.error(error.category ?? 'PARTICIPANT_START_FAILED');
        }
      }));
    };
    await startParticipants(0, initialCount, config.joinWindowMs);
    if (participants.length !== initialCount || participants.some((participant) => !participant.playerId || participant.status !== 'SUBSCRIBED')) {
      throw new Error('Not every participant joined and subscribed; refusing to produce a capacity PASS.');
    }

    for (let roundIndex = 0; roundIndex < config.rounds; roundIndex += 1) {
      if (aborted) throw new Error('Run interrupted.');
      await hostAction(roundIndex === 0 ? 'start' : 'next_round', 'question_open', roundIndex);
      if (roundIndex === 0 && lateCount > 0) {
        await startParticipants(initialCount, lateCount, config.lateJoinWindowMs);
        if (participants.length !== config.participants || participants.some((participant) => !participant.playerId || participant.status !== 'SUBSCRIBED')) {
          throw new Error('Not every active-play late participant joined and subscribed; refusing to produce a capacity PASS.');
        }
      }
      if (roundIndex === 0 && config.participants === 225) {
        metrics.capacityBoundary.attempted += 1;
        try {
          await pagesJson(`/api/rooms/${room.code}/join`, {
            method: 'POST',
            body: {
              name: `Capacity ${runId} overflow`,
              participantToken: randomToken(),
              idempotencyKey: randomUUID(),
            },
            expectedErrors: new Set(['ROOM_FULL']),
          });
          metrics.capacityBoundary.failed += 1;
          metrics.error('ROOM_FULL_BOUNDARY_FAILED');
          throw new Error('The 226th participant was unexpectedly admitted.');
        } catch (error) {
          if (error.category === 'ROOM_FULL') metrics.capacityBoundary.rejectedRoomFull += 1;
          else throw error;
        }
      }
      const readyDeadline = Date.now() + config.transitionTimeoutMs;
      while (Date.now() < readyDeadline && participants.some((participant) => !participant.currentSnapshot?.choices?.length)) await sleep(25);
      if (participants.some((participant) => !participant.currentSnapshot?.choices?.length)) throw new Error('Participants did not hydrate answer choices.');
      const duplicateCount = Math.ceil(participants.length * config.duplicatePercent / 100);
      const raceCount = roundIndex === 0 ? boundedLockRaceCount(config) : 0;
      const normalParticipants = raceCount ? participants.slice(0, -raceCount) : participants;
      const raceParticipants = raceCount ? participants.slice(-raceCount) : [];
      const answerTasks = normalParticipants.map(async (participant, index) => {
        await sleep(config.answerWindowMs ? Math.round(index * config.answerWindowMs / Math.max(1, normalParticipants.length - 1)) : 0);
        const correctChoiceId = context.correctChoiceByRound.get(roundIndex);
        const cohort = participant.index % 5;
        const shouldAnswerCorrectly = cohort === 0
          || (cohort === 1 && roundIndex !== 1)
          || (cohort === 3 && roundIndex % 2 === 0);
        const choiceId = shouldAnswerCorrectly
          ? correctChoiceId
          : participant.currentSnapshot.choices.find((choice) => choice.id !== correctChoiceId).id;
        const alternative = participant.currentSnapshot.choices.find((choice) => choice.id !== choiceId)?.id;
        await participant.answer(choiceId, alternative, index < duplicateCount, roundIndex);
      });
      const answerResults = await Promise.allSettled(answerTasks);
      const rejectedAnswers = answerResults.filter((result) => result.status === 'rejected');
      if (rejectedAnswers.length) throw new Error(`${rejectedAnswers.length} answer task(s) failed after all in-flight answers settled.`);

      if (roundIndex === 0 && config.reconnectPercent > 0) {
        const count = Math.min(Math.ceil(participants.length * config.reconnectPercent / 100), normalParticipants.length);
        await Promise.all(normalParticipants.slice(0, count).map((participant) => participant.reconnect()));
      }

      if (raceParticipants.length) {
        let releaseRace;
        const raceGate = new Promise((resolvePromise) => { releaseRace = resolvePromise; });
        const raceAnswers = raceParticipants.map(async (participant) => {
          await raceGate;
          const correctChoiceId = context.correctChoiceByRound.get(roundIndex);
          const cohort = participant.index % 5;
          const shouldAnswerCorrectly = cohort === 0
            || (cohort === 1 && roundIndex !== 1)
            || (cohort === 3 && roundIndex % 2 === 0);
          const choiceId = shouldAnswerCorrectly
            ? correctChoiceId
            : participant.currentSnapshot.choices.find((choice) => choice.id !== correctChoiceId).id;
          const alternative = participant.currentSnapshot.choices.find((choice) => choice.id !== choiceId)?.id;
          return participant.answer(choiceId, alternative, false, roundIndex, true);
        });
        const lockStarted = performance.now();
        const lockTask = (async () => {
          await raceGate;
          await hostAction('lock', 'answers_locked', roundIndex);
          return { outcome: 'locked' };
        })();
        releaseRace();
        const raced = await Promise.allSettled([lockTask, ...raceAnswers]);
        const lockResult = raced[0];
        const answerResultsAtLock = raced.slice(1);
        const acceptedAtLock = answerResultsAtLock.filter((result) => result.status === 'fulfilled' && result.value.outcome === 'accepted').length;
        const closedAtLock = answerResultsAtLock.filter((result) => result.status === 'fulfilled' && result.value.outcome === 'answers_closed').length;
        const unexpectedAtLock = answerResultsAtLock.length - acceptedAtLock - closedAtLock;
        metrics.answerLockRace.push({
          roundIndex,
          clients: raceParticipants.length,
          accepted: acceptedAtLock,
          answersClosed: closedAtLock,
          unexpected: unexpectedAtLock,
          lockTransitionLatencyMs: Math.round((performance.now() - lockStarted) * 10) / 10,
        });
        if (lockResult.status === 'rejected') throw lockResult.reason;
        if (unexpectedAtLock !== 0 || acceptedAtLock + closedAtLock !== raceParticipants.length) {
          metrics.error('ANSWER_LOCK_RACE_INVALID');
          throw new Error('Answer/Lock race produced an outcome other than accepted or ANSWERS_CLOSED.');
        }
      } else {
        await hostAction('lock', 'answers_locked', roundIndex);
      }
      await hostAction('reveal', 'employee_revealed', roundIndex);
      await hostAction('show_results', 'results_displayed', roundIndex);
      const showLeaderboard = roundIndex === 0 || roundIndex === config.rounds - 1;
      if (showLeaderboard) await hostAction('show_leaderboard', 'leaderboard_displayed', roundIndex);
      await verifyScoring(roundIndex, showLeaderboard);
    }
    if (config.rounds === lobby.snapshot.roundCount) await hostAction('end', 'complete', config.rounds - 1);
  } catch (error) {
    primaryError = error;
  } finally {
    try { await cleanup(); } catch (error) { cleanupError = error; }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt).getTime() - new Date(metrics.startedAt).getTime();
  clearInterval(memoryTimer);
  eventLoop.disable();
  generator.eventLoopDelay = {
    meanMs: Math.round(eventLoop.mean / 1e5) / 10,
    p95Ms: Math.round(eventLoop.percentile(95) / 1e5) / 10,
    maxMs: Math.round(eventLoop.max / 1e5) / 10,
  };
  const cpu = process.cpuUsage(cpuStarted);
  generator.cpu = {
    userMs: Math.round(cpu.user / 100) / 10,
    systemMs: Math.round(cpu.system / 100) / 10,
    singleCoreUtilizationPercent: durationMs > 0
      ? Math.round(((cpu.user + cpu.system) / (durationMs * 1_000)) * 1_000) / 10
      : null,
  };
  generator.thresholds = { eventLoopP95Ms: 100, eventLoopMaxMs: 1_000, peakRssBytes: 1_610_612_736 };
  generator.healthy = generator.eventLoopDelay.p95Ms <= generator.thresholds.eventLoopP95Ms
    && generator.eventLoopDelay.maxMs <= generator.thresholds.eventLoopMaxMs
    && generator.peakRssBytes <= generator.thresholds.peakRssBytes;
  const missedTransitions = metrics.transitions.reduce((sum, transition) => sum + transition.missed, 0);
  const expectedDuplicates = Math.ceil(config.participants * config.duplicatePercent / 100);
  const expectedReconnects = Math.min(
    Math.ceil(config.participants * config.reconnectPercent / 100),
    config.participants - boundedLockRaceCount(config),
  );
  const expectedTransitions = config.rounds * 4 + leaderboardTransitionCount(config.rounds)
    + (metrics.transitions.some((transition) => transition.phase === 'complete') ? 1 : 0);
  const hasUnexpectedErrors = Object.keys(metrics.errors).length > 0;
  const invariantFailures = [];
  if (metrics.joins.successful !== config.participants || metrics.joins.failed !== 0) invariantFailures.push('join totals');
  if (metrics.joins.idempotentRetries !== expectedDuplicates || metrics.joins.retryFailures !== 0) invariantFailures.push('join idempotency');
  if (metrics.answers.logicalAttempted !== config.participants * config.rounds
    || metrics.answers.successful + metrics.answers.closedAtLock !== config.participants * config.rounds
    || metrics.answers.failed !== 0) invariantFailures.push('answer totals');
  if (metrics.answers.duplicateProbeFailures !== 0
    || metrics.answers.idempotentDuplicates !== expectedDuplicates * config.rounds
    || metrics.answers.immutableDuplicates !== expectedDuplicates * config.rounds) invariantFailures.push('answer idempotency/immutability');
  if (metrics.scoring.mismatches !== 0 || metrics.scoring.rounds.length !== config.rounds
    || metrics.scoring.expectedTotalPoints !== metrics.scoring.actualTotalPoints) invariantFailures.push('authoritative score ledger/aggregates');
  if (metrics.leaderboard.mismatches !== 0 || metrics.leaderboard.checks.length !== leaderboardTransitionCount(config.rounds)
    || metrics.leaderboard.personalRankChecks !== config.participants * leaderboardTransitionCount(config.rounds)) invariantFailures.push('leaderboard/personal ranks');
  if (metrics.reconnect.attempted !== expectedReconnects || metrics.reconnect.successful !== expectedReconnects
    || metrics.reconnect.identityRecovered !== expectedReconnects
    || metrics.reconnect.idempotentResubmits !== expectedReconnects || metrics.reconnect.failed !== 0) invariantFailures.push('reconnect recovery');
  if (metrics.snapshot.failed !== 0) invariantFailures.push('snapshot failures');
  if (metrics.realtime.channelErrors !== 0 || metrics.realtime.invalidEvents !== 0
    || metrics.realtime.samePhaseEvents !== 0 || metrics.realtime.maxChannelsPerClient !== 1
    || metrics.realtime.peakSubscribed !== config.participants) invariantFailures.push('Realtime topology/events');
  if (hasUnexpectedErrors) invariantFailures.push('unexpected error categories');
  if (metrics.transitions.length !== expectedTransitions || missedTransitions !== 0) invariantFailures.push('transition delivery');
  if (metrics.answerLockRace.length !== (boundedLockRaceCount(config) > 0 ? 1 : 0)
    || metrics.answerLockRace.some((race) => race.unexpected !== 0
      || race.accepted + race.answersClosed !== race.clients)) invariantFailures.push('answer/Lock boundary race');
  if (config.participants === 225 && (metrics.capacityBoundary.attempted !== 1
    || metrics.capacityBoundary.rejectedRoomFull !== 1 || metrics.capacityBoundary.failed !== 0)) invariantFailures.push('226th participant boundary');
  if (!generator.healthy) invariantFailures.push('load generator health');
  if (config.browserObservers && (!browserObservers
    || browserObservers.report.transitionObservations.length !== expectedTransitions
    || browserObservers.report.hostConsoleErrors !== 0 || browserObservers.report.displayConsoleErrors !== 0
    || browserObservers.report.pageErrors !== 0 || browserObservers.report.requestFailures !== 0
    || browserObservers.report.serverResponses !== 0)) invariantFailures.push('host/display browser observers');
  const report = {
    schemaVersion: 1,
    runId,
    startedAt: metrics.startedAt,
    finishedAt,
    environment: {
      origin: target.origin,
      hostname: new URL(target.origin).hostname,
      gameId: process.env.CAPACITY_GAME_ID,
      operatorRecordedGitCommit: process.env.CAPACITY_GIT_COMMIT,
      operatorRecordedDeploymentId: process.env.CAPACITY_DEPLOYMENT_ID,
      deploymentIdentityVerification: 'Operator supplied; correlate both values with the Cloudflare deployment dashboard before accepting the report.',
    },
    configuration: config,
    estimate: estimate(config),
    results: {
      attemptedParticipants: config.participants,
      joins: metrics.joins,
      activeRealtimeConnectionsAtPeak: metrics.realtime.peakSubscribed,
      realtime: metrics.realtime,
      answers: metrics.answers,
      joinLatency: summarize(metrics.joinLatencies),
      participantReadyLatency: summarize(metrics.readyLatencies),
      answerLatency: summarize(metrics.answerLatencies),
      personalHydrationLatency: summarize(metrics.personalHydrationLatencies),
      scoring: metrics.scoring,
      leaderboard: metrics.leaderboard,
      transitions: metrics.transitions,
      reconnect: metrics.reconnect,
      capacityBoundary: metrics.capacityBoundary,
      answerLockRace: metrics.answerLockRace,
      snapshots: metrics.snapshot,
      httpRequests: metrics.http,
      approximateRealtimeEventVolume: metrics.realtime.inboundEvents,
      errorsByCategory: metrics.errors,
      durationMs,
      loadGenerator: generator,
      browserObservers: browserObservers?.report ?? { enabled: false },
      cleanup: cleanupError ? { passed: false, error: safeError(cleanupError) } : { passed: true, roomDeleted: Boolean(room) },
    },
    exclusions: [
      'No static frontend bundles or Mystery/Reveal image bytes are downloaded.',
      'Each simulated browser fetches the public Realtime credential once; no Supabase Auth users are created.',
      'A real host browser and shared display are outside this protocol harness and must be run separately for the final rehearsal.',
      'Duplicate join operations and concurrent duplicate answers are covered here; duplicate-tab UI/socket behavior is covered by the real-browser gauntlet.',
      'Platform dashboard metrics are not inferred; correlate this report with Supabase and Cloudflare dashboards.',
    ],
    pass: !primaryError && !cleanupError && invariantFailures.length === 0,
    failure: primaryError ? safeError(primaryError)
      : cleanupError ? safeError(cleanupError)
        : invariantFailures.length ? `Invariant failure: ${invariantFailures.join(', ')}` : null,
  };
  if (config.output) {
    const path = resolve(config.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

const config = parseArgs(process.argv.slice(2));
if (config.help) console.log(usage());
else if (!config.execute) console.log(JSON.stringify({ mode: 'dry-run', configuration: config, estimate: estimate(config) }, null, 2));
else await run(config, validateExecution(config));
