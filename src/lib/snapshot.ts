import { gamePhases, type GameSnapshot, type RevealedEmployee } from '../domain/game';
import type { RevealKey } from './assetPreloader';

const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const B64_12 = /^[A-Za-z0-9_-]{16}$/;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;

export function shouldReplaceSnapshot(source: 'http' | 'push', nextVersion: number, currentVersion: number, lastPushedVersion: number): boolean {
  if (nextVersion < currentVersion) return false;
  if (source === 'http' && nextVersion === currentVersion && lastPushedVersion === nextVersion) return false;
  if (source === 'push' && nextVersion === currentVersion && lastPushedVersion === nextVersion) return false;
  return true;
}

export function preserveRevealEnrichment(current: GameSnapshot | null, next: GameSnapshot): GameSnapshot {
  const prior = current?.revealedEmployee;
  const incoming = next.revealedEmployee;
  const postReveal = new Set(['employee_revealed', 'results_displayed', 'complete']);
  if (!prior?.revealKey || incoming?.revealKey || !postReveal.has(current?.phase ?? '') || !postReveal.has(next.phase)) return next;
  if (current?.roomCode !== next.roomCode || current.roundIndex !== next.roundIndex || prior.id !== incoming?.id || prior.mediaKey !== incoming.mediaKey) return next;
  return { ...next, revealedEmployee: { ...incoming, revealKey: prior.revealKey } };
}

export function parsePushedSnapshot(value: unknown, expectedCode: string, expectedVersion: number, expectedPhase: unknown): GameSnapshot | null {
  const row = record(value);
  if (!row || !CODE.test(expectedCode) || row.roomCode !== expectedCode || row.version !== expectedVersion || row.phase !== expectedPhase || !gamePhases.includes(row.phase as never)) return null;
  const phase = row.phase as GameSnapshot['phase'];
  const version = integer(row.version);
  const roundCount = integer(row.roundCount, 1);
  const roundIndex = row.roundIndex === null ? null : integer(row.roundIndex);
  const connected = integer(row.connectedParticipantCount);
  const eligible = integer(row.eligibleParticipantCount);
  const submitted = integer(row.submittedAnswerCount);
  if (version === null || roundCount === null || connected === null || eligible === null || submitted === null || eligible > connected || submitted > eligible) return null;
  if ((phase === 'lobby') !== (roundIndex === null) || (roundIndex !== null && roundIndex >= roundCount)) return null;
  if (!Array.isArray(row.choices) || row.choices.length > 10 || (phase !== 'lobby' && row.choices.length < 2)) return null;
  const choices = row.choices.map((item) => {
    const choice = record(item); const position = choice ? integer(choice.position) : null;
    if (!choice || typeof choice.id !== 'string' || !UUID.test(choice.id) || typeof choice.displayName !== 'string' || choice.displayName.length < 1 || choice.displayName.length > 100 || position === null) return null;
    return { id: choice.id, displayName: choice.displayName, position };
  });
  if (choices.some((choice) => choice === null) || choices.some((choice, index) => choice?.position !== index) || new Set(choices.map((choice) => choice?.id)).size !== choices.length) return null;

  const revealPhases = ['employee_revealed', 'results_displayed', 'complete'];
  let revealedEmployee: RevealedEmployee | null = null;
  if (row.revealedEmployee !== null) {
    if (!revealPhases.includes(phase)) return null;
    const reveal = record(row.revealedEmployee);
    if (!reveal || typeof reveal.id !== 'string' || !UUID.test(reveal.id) || typeof reveal.displayName !== 'string' || reveal.displayName.length < 1 || reveal.displayName.length > 100 || typeof reveal.mediaAvailable !== 'boolean') return null;
    if (!(reveal.team === null || (typeof reveal.team === 'string' && reveal.team.length <= 100)) || !(reveal.funFact === null || (typeof reveal.funFact === 'string' && reveal.funFact.length <= 500))) return null;
    const mediaKeyPresent = reveal.mediaKey !== null && reveal.mediaKey !== undefined;
    const mediaKey = mediaKeyPresent ? text(reveal.mediaKey, 80) : null;
    if (mediaKeyPresent && mediaKey === null) return null;
    if (mediaKey && mediaKey !== `${expectedCode}:${roundIndex}:reveal`) return null;
    const materialPresent = reveal.revealKey !== null && reveal.revealKey !== undefined;
    const material = materialPresent ? record(reveal.revealKey) : null;
    if (materialPresent && material === null) return null;
    if (material && (!(typeof material.key === 'string' && B64_32.test(material.key)) || !(typeof material.iv === 'string' && B64_12.test(material.iv)) || typeof material.mimeType !== 'string' || !MIME.has(material.mimeType) || typeof material.aad !== 'string' || !/^name-that:[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(material.aad))) return null;
    const revealKey: RevealKey | undefined = material ? { key: material.key as string, iv: material.iv as string, mimeType: material.mimeType as RevealKey['mimeType'], aad: material.aad as string } : undefined;
    revealedEmployee = { id: reveal.id, displayName: reveal.displayName, team: reveal.team, funFact: reveal.funFact, mediaAvailable: reveal.mediaAvailable, mediaKey, ...(revealKey ? { revealKey } : {}) };
  }

  if (!Array.isArray(row.preloadAssets) || row.preloadAssets.length > 4) return null;
  const preloadAssets = row.preloadAssets.map((item) => {
    const asset = record(item); const assetRound = asset ? integer(asset.roundIndex) : null;
    if (!asset || typeof asset.key !== 'string' || typeof asset.kind !== 'string' || !['mystery', 'reveal-encrypted'].includes(asset.kind) || assetRound === null || typeof asset.url !== 'string') return null;
    const suffix = asset.kind === 'mystery' ? 'mystery' : 'reveal';
    const endpoint = asset.kind === 'mystery' ? 'mystery-preload' : 'reveal-preload';
    const match = asset.url.match(new RegExp(`^/api/rooms/${expectedCode}/${endpoint}\\?round=(${assetRound})&asset=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`));
    if (asset.key !== `${expectedCode}:${assetRound}:${suffix}` || !match || !UUID.test(match[2] ?? '')) return null;
    return { key: asset.key, kind: asset.kind as 'mystery' | 'reveal-encrypted', roundIndex: assetRound, url: asset.url };
  });
  if (preloadAssets.some((asset) => asset === null)) return null;

  let results: GameSnapshot['results'] = null;
  if (row.results !== null) {
    if (!['results_displayed', 'complete'].includes(phase)) return null;
    const result = record(row.results); const total = result ? integer(result.totalAnswers) : null; const correct = result ? integer(result.correctAnswers) : null;
    if (!result || total === null || correct === null || correct > total || !Array.isArray(result.choices) || result.choices.length > 10) return null;
    const resultChoices = result.choices.map((item) => { const choice = record(item); const count = choice ? integer(choice.count) : null; return choice && typeof choice.employeeId === 'string' && UUID.test(choice.employeeId) && count !== null ? { employeeId: choice.employeeId, count } : null; });
    if (resultChoices.some((item) => item === null) || new Set(resultChoices.map((item) => item?.employeeId)).size !== resultChoices.length || resultChoices.some((item) => !choices.some((choice) => choice?.id === item?.employeeId))) return null;
    results = { totalAnswers: total, correctAnswers: correct, choices: resultChoices as NonNullable<GameSnapshot['results']>['choices'] };
  }
  const updatedAt = text(row.updatedAt, 50); if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  const prompt = row.prompt === null || row.prompt === undefined ? undefined : text(row.prompt, 200); if (prompt === null) return null;
  const mysteryImageUrl = row.mysteryImageUrl === null || row.mysteryImageUrl === undefined ? null : text(row.mysteryImageUrl, 200); if (mysteryImageUrl && mysteryImageUrl !== `/api/rooms/${expectedCode}/mystery`) return null;
  const silhouetteUrl = row.silhouetteUrl === null || row.silhouetteUrl === undefined ? null : text(row.silhouetteUrl, 200); if (silhouetteUrl && silhouetteUrl !== `/api/rooms/${expectedCode}/mystery`) return null;
  return { roomCode: expectedCode, phase, roundIndex, roundCount, connectedParticipantCount: connected, eligibleParticipantCount: eligible, submittedAnswerCount: submitted, version, choices: choices as GameSnapshot['choices'], revealedEmployee, results, updatedAt, ...(prompt === undefined ? {} : { prompt }), mysteryImageUrl, silhouetteUrl, preloadAssets: preloadAssets as NonNullable<GameSnapshot['preloadAssets']> };
}
