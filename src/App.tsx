import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { GameDefinition, GameQuestionDefinition, GameSummary, SessionCreationOperation } from './domain/admin';
import type { Choice, GamePhase, GameSnapshot, HostAction } from './domain/game';
import { phaseLabels } from './domain/game';
import { useRoomSnapshot } from './hooks/useRoomSnapshot';
import {
  ApiError, createAdminSession, createGame, createGameRoom, deleteGame, errorMessage, getGame, getHostRoom, getRevealKey,
  joinRoom, listGames, loadGameMediaBlob, performDirectHostAction, playAgain, submitAnswer, updateGame, uploadGameMedia,
} from './lib/api';
import { adminSession, hostSession, participantSession, type HostSession, type ParticipantSession } from './lib/session';
import { newSessionOperation } from './lib/sessionOperation';
import { preloadAssets, preloadedImageObjectUrl, releaseRoomAssets, revealObjectUrl, type PreloadAsset } from './lib/assetPreloader';
import { normalizeUpload } from './lib/imageUpload';

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}$/;
const choiceMarks = 'ABCDEFGHIJ'.split('');
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const answerDenominator = (snapshot: GameSnapshot) => snapshot.eligibleParticipantCount ?? snapshot.connectedParticipantCount;


function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  const [, setNavigationRevision] = useState(0);
  useEffect(() => {
    // A successful join can navigate from /play/:code to that same URL. React
    // otherwise bails out of the equal path update and leaves the join form
    // mounted even though the participant credential was just persisted.
    const update = () => {
      setPath(location.pathname);
      setNavigationRevision((revision) => revision + 1);
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}

function Brand({ compact = false, inert = false }: { compact?: boolean; inert?: boolean }) {
  const content = <><span className="brand__aperture" aria-hidden="true"><i /></span><span><b>Name That</b><strong>Team Member</strong></span></>;
  if (inert) return <div aria-label="Name That Team Member" className={`brand brand--inert ${compact ? 'brand--compact' : ''}`}>{content}</div>;
  return <a aria-label="Name That Team Member" className={`brand ${compact ? 'brand--compact' : ''}`} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
    {content}
  </a>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

function Spinner({ label = 'Loading the next scene' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" /><strong>{label}</strong></div>;
}

function PortraitChamber({ src, revealed = false, name = 'Mystery teammate', compact = false }: { src?: string | null | undefined; revealed?: boolean; name?: string; compact?: boolean }) {
  return <div className={`portrait-chamber ${revealed ? 'is-revealed' : 'is-concealed'} ${compact ? 'is-compact' : ''}`} aria-label={revealed ? `Revealed portrait of ${name}` : 'Mystery teammate portrait concealed until the reveal'}>
    <span className="chamber-rays" aria-hidden="true" />
    <div className="chamber-photo">
      {src ? <img src={src} alt={revealed ? `Portrait of ${name}` : ''} /> : <div className="chamber-figure" aria-hidden="true"><i /><b /></div>}
      {!revealed && <span className="scan-line" aria-hidden="true" />}
    </div>
    <span className="chamber-corner chamber-corner--a" aria-hidden="true" />
    <span className="chamber-corner chamber-corner--b" aria-hidden="true" />
    {!revealed && <strong className="mystery-mark" aria-hidden="true">?</strong>}
  </div>;
}

function RoomRevealPortrait({ code, reveal, assets, compact = false }: { code: string; reveal: NonNullable<GameSnapshot['revealedEmployee']>; assets: readonly PreloadAsset[] | undefined; compact?: boolean }) {
  const [preloadedUrl, setPreloadedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(!reveal.mediaKey);
  useEffect(() => {
    if (!reveal.mediaKey) { setPreloadedUrl(null); setFailed(true); return; }
    let cancelled = false;
    setFailed(false);
    const asset = assets?.find((candidate) => candidate.key === reveal.mediaKey && candidate.kind === 'reveal-encrypted');
    const key = reveal.revealKey ? Promise.resolve(reveal.revealKey) : getRevealKey(code, reveal.id);
    void key.then((material) => revealObjectUrl(reveal.mediaKey!, material, asset)).then((url) => { if (!cancelled) { setPreloadedUrl(url); setFailed(!url); } }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [assets, code, reveal.id, reveal.mediaKey, reveal.revealKey]);
  return <PortraitChamber src={preloadedUrl ?? (failed && reveal.mediaAvailable ? `/api/rooms/${code}/media/${reveal.id}` : null)} revealed name={reveal.displayName} compact={compact} />;
}

function useMysteryImage(roundIndex: number | null, assets: readonly PreloadAsset[] | undefined, fallback: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const asset = assets?.find((candidate) => candidate.kind === 'mystery' && candidate.roundIndex === roundIndex);
  useEffect(() => {
    if (!asset) { setUrl(null); setFailed(false); return; }
    let cancelled = false;
    setFailed(false);
    void preloadedImageObjectUrl(asset).then((next) => { if (!cancelled) { setUrl(next); setFailed(!next); } });
    return () => { cancelled = true; };
  }, [asset]);
  return asset ? url ?? (failed ? fallback ?? null : null) : fallback ?? null;
}

function Home() {
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
  return <main className="home-shell show-surface">
    <header className="site-header"><Brand /><a href="/host" onClick={(event) => { event.preventDefault(); navigate('/host'); }}>Host studio <span>↗</span></a></header>
    <section className="home-stage">
      <div className="home-copy">
        <p className="eyebrow"><span>Tonight’s mystery</span></p>
        <h1>Think you know your <em>crew?</em></h1>
        <p>Spot the silhouette. Lock in your guess. Meet the teammate behind the mystery.</p>
      </div>
      <PortraitChamber />
      <form className="join-console angle-panel" onSubmit={(event) => { event.preventDefault(); if (CODE_PATTERN.test(clean)) navigate(`/join/${clean}`); }}>
        <span className="console-label">Audience entrance</span>
        <h2>Join the show</h2>
        <label htmlFor="room-code">Room code</label>
        <input id="room-code" className="code-input" value={clean} onChange={(event) => setCode(event.target.value)} placeholder="F7K2M" autoComplete="off" autoCapitalize="characters" maxLength={5} />
        <button className="button button--hot button--block" disabled={!CODE_PATTERN.test(clean)}>Enter the studio <span>→</span></button>
      </form>
    </section>
    <footer className="show-footer"><span>Faces you know</span><i /><span>Stories you don’t</span></footer>
  </main>;
}

function GameEnded({ code }: { code: string }) {
  return <main className="join-page show-surface game-ended"><Brand inert /><div className="angle-panel finale-card"><span className="finale-burst">★</span><p className="eyebrow">Room {code}</p><h1>This game has ended.</h1><p>The final teammate has already been revealed. Ask your host for the new room code.</p></div></main>;
}

function Join({ code }: { code: string }) {
  const existing = participantSession.get(code);
  const [name, setName] = useState(existing?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => { if (existing) navigate(`/play/${code}`); }, [code, existing]);

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await joinRoom(code, name.trim());
      participantSession.set({ ...response.participant, code, token: response.participantToken });
      navigate(`/play/${code}`);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === 'GAME_ENDED' || reason.status === 410)) setEnded(true);
      else setError(errorMessage(reason));
    } finally { setBusy(false); }
  }

  if (ended) return <GameEnded code={code} />;
  return <main className="join-page show-surface">
    <header className="site-header"><Brand compact inert /><span className="room-chip">Room <strong>{code}</strong></span></header>
    <section className="join-layout">
      <div className="join-poster"><p className="eyebrow">You found the studio</p><h1>Step into the mystery.</h1><PortraitChamber compact /></div>
      <form className="name-console angle-panel" onSubmit={(event) => { void handleJoin(event); }}>
        <span className="console-label">Player check-in</span><h2>What should we call you?</h2><p>Your name appears on the host screen.</p>
        <label htmlFor="display-name">Display name</label>
        <input id="display-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={40} placeholder="e.g. Alex" autoFocus />
        {error && <Notice tone="error">{error}</Notice>}
        <button className="button button--hot button--block" disabled={busy || !name.trim()}>{busy ? 'Joining…' : 'I’m ready'} <span>→</span></button>
        <small>No account needed.</small>
      </form>
    </section>
  </main>;
}

function RoundHeader({ snapshot, name }: { snapshot: GameSnapshot; name?: string }) {
  const round = snapshot.roundIndex === null ? 0 : snapshot.roundIndex + 1;
  return <header className="game-header"><Brand compact inert /><div>{name && <span className="player-chip">{name}</span>}<span className="round-chip">Round <strong>{round}</strong> / {snapshot.roundCount}</span></div></header>;
}

function Results({ snapshot, large = false }: { snapshot: GameSnapshot; large?: boolean }) {
  if (!snapshot.results) return null;
  const max = Math.max(1, ...snapshot.results.choices.map((item) => item.count));
  const correct = snapshot.revealedEmployee?.id;
  return <section className={`results ${large ? 'results--large' : ''}`} aria-label="Answer results">
    <div className="results__score"><strong>{snapshot.results.correctAnswers}</strong><span>of {snapshot.results.totalAnswers}<br />nailed the mystery</span></div>
    <div className="result-lanes">{snapshot.results.choices.map((item, index) => {
      const choice = snapshot.choices.find((entry) => entry.id === item.employeeId);
      const isCorrect = item.employeeId === correct;
      return <div className={`result-lane ${isCorrect ? 'is-correct' : ''}`} key={item.employeeId}>
        <div><b>{choiceMarks[index]}</b><span>{choice?.displayName ?? 'Choice'}</span>{isCorrect && <em>Correct</em>}<strong>{item.count}</strong></div>
        <i><b style={{ width: `${(item.count / max) * 100}%` }} /></i>
      </div>;
    })}</div>
  </section>;
}

function ParticipantGame({ code, session }: { code: string; session: ParticipantSession }) {
  const auth = useMemo(() => ({ token: session.token, playerId: session.playerId }), [session.playerId, session.token]);
  const room = useRoomSnapshot(code, auth);
  useEffect(() => () => releaseRoomAssets(code), [code]);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preloadedRevealUrl, setPreloadedRevealUrl] = useState<string | null>(null);
  const [revealPreloadFailed, setRevealPreloadFailed] = useState(false);
  const answerId = room.participantState?.answerEmployeeId ?? selected;
  useEffect(() => { if (room.snapshot?.phase === 'question_open' && !room.participantState?.answerEmployeeId) setSelected(null); }, [room.snapshot?.roundIndex, room.snapshot?.phase, room.participantState?.answerEmployeeId]);
  useEffect(() => { preloadAssets(room.snapshot?.preloadAssets); }, [room.snapshot?.preloadAssets]);
  useEffect(() => {
    const revealed = room.snapshot?.revealedEmployee;
    const revealPhase = ['employee_revealed', 'results_displayed'].includes(room.snapshot?.phase ?? '');
    if (!revealPhase) { setPreloadedRevealUrl(null); setRevealPreloadFailed(false); return; }
    if (!revealed?.mediaKey) { setPreloadedRevealUrl(null); setRevealPreloadFailed(true); return; }
    let cancelled = false;
    setRevealPreloadFailed(false);
    const key = revealed.revealKey ? Promise.resolve(revealed.revealKey) : getRevealKey(code, revealed.id);
    void key
      .then((key) => revealObjectUrl(revealed.mediaKey!, key, room.snapshot?.preloadAssets?.find((asset) => asset.key === revealed.mediaKey && asset.kind === 'reveal-encrypted')))
      .then((url) => { if (!cancelled) { setPreloadedRevealUrl(url); setRevealPreloadFailed(!url); } })
      .catch(() => { if (!cancelled) { setPreloadedRevealUrl(null); setRevealPreloadFailed(true); } });
    return () => { cancelled = true; };
  }, [code, room.snapshot?.phase, room.snapshot?.preloadAssets, room.snapshot?.revealedEmployee]);
  const mysterySrc = useMysteryImage(room.snapshot?.roundIndex ?? null, room.snapshot?.preloadAssets, room.snapshot?.mysteryImageUrl ?? room.snapshot?.silhouetteUrl);

  async function choose(choice: Choice) {
    if (answerId || room.snapshot?.phase !== 'question_open' || submitting) return;
    setSelected(choice.id); setSubmitting(true); setSubmitError(null);
    try { await submitAnswer(code, session.token, session.playerId, choice.id); await room.refetch(true); }
    catch (reason) { setSelected(null); setSubmitError(errorMessage(reason)); }
    finally { setSubmitting(false); }
  }

  if (room.loading && !room.snapshot) return <main className="participant-shell"><Spinner /></main>;
  if (!room.snapshot) return <main className="participant-shell error-page"><Brand compact inert /><h1>We lost the room.</h1><Notice tone="error">{room.error ?? 'This game is not available.'}</Notice><button className="button button--light" onClick={() => { void room.refetch(); }}>Try again</button></main>;
  const snapshot = room.snapshot;
  const reveal = snapshot.revealedEmployee;
  const chosenName = snapshot.choices.find((choice) => choice.id === answerId)?.displayName;
  const revealSrc = preloadedRevealUrl ?? (revealPreloadFailed && reveal?.mediaAvailable ? `/api/rooms/${code}/media/${reveal.id}` : null);
  return <main className={`participant-shell phase-${snapshot.phase}`}>
    <RoundHeader snapshot={snapshot} name={session.displayName} />
    {(room.offline || room.error) && <div className="connection-banner" role="status">{room.offline ? 'You’re offline — reconnecting automatically.' : 'Connection interrupted. Retrying…'}</div>}
    <section className="participant-stage" aria-live="polite">
      {snapshot.phase === 'lobby' && <div className="participant-wait"><span className="status-orbit">✓</span><p className="eyebrow">You’re on the guest list</p><h1>Welcome, {session.displayName}.</h1><p>The host is getting the first mystery ready.</p><div className="waiting-meter"><i /><i /><i /><i /></div></div>}
      {snapshot.phase === 'question_open' && <div className="participant-question"><header><PortraitChamber src={mysterySrc} compact /><div><p className="eyebrow">Choose your suspect</p><h1>{snapshot.prompt ?? 'Who is this team member?'}</h1><span>{answerId ? 'Your answer is locked in.' : 'Tap one answer below.'}</span></div></header><div className="choice-grid">{snapshot.choices.map((choice, index) => <button key={choice.id} className={`choice ${answerId === choice.id ? 'is-selected' : ''} ${answerId && answerId !== choice.id ? 'is-muted' : ''}`} disabled={Boolean(answerId) || submitting} onClick={() => { void choose(choice); }}><b>{choiceMarks[index]}</b><span>{choice.displayName}</span>{answerId === choice.id && <em>Locked</em>}</button>)}</div>{submitError && <Notice tone="error">{submitError}</Notice>}{answerId && <div className="submitted-banner"><strong>Locked in: {chosenName}</strong><span>Watch the shared screen for the reveal.</span></div>}</div>}
      {snapshot.phase === 'answers_locked' && <div className="participant-wait locked"><span className="lock-stamp">Locked in</span><h1>{chosenName ? `You picked ${chosenName}.` : 'Voting is closed.'}</h1><p>The spotlight is about to turn on.</p></div>}
      {(snapshot.phase === 'employee_revealed' || snapshot.phase === 'results_displayed') && reveal && <div className="participant-reveal"><p className="eyebrow">Mystery solved</p><PortraitChamber src={revealSrc} revealed name={reveal.displayName} /><h1>{reveal.displayName}</h1>{reveal.team && <p className="team-line">{reveal.team}</p>}{reveal.funFact && <blockquote>“{reveal.funFact}”</blockquote>}{snapshot.phase === 'results_displayed' && <Results snapshot={snapshot} />}</div>}
      {snapshot.phase === 'complete' && <div className="participant-wait finale"><span className="finale-burst">★</span><p className="eyebrow">Final curtain</p><h1>That’s the whole crew!</h1><p>Thanks for playing, {session.displayName}.</p></div>}
    </section>
    <footer className="participant-footer"><span>Room {code}</span>{snapshot.phase === 'complete' ? <span>Complete</span> : <span className="live-dot">Live</span>}</footer>
  </main>;
}

function ParticipantRoute({ code }: { code: string }) {
  const session = participantSession.get(code);
  return session ? <ParticipantGame key={`${code}:${session.roomId}`} code={code} session={session} /> : <Join key={`missing:${code}`} code={code} />;
}

function useAdminIdentity() {
  const [admin, setAdmin] = useState(() => adminSession.get());
  const [loading, setLoading] = useState(!admin);
  const [error, setError] = useState<string | null>(null);
  const establish = useCallback(async (replace = false) => {
    setLoading(true); setError(null);
    try {
      if (!replace) { const stored = adminSession.get(); if (stored) { setAdmin(stored); return stored; } }
      const created = await createAdminSession(); adminSession.set(created); setAdmin(created); return created;
    } catch (reason) { setError(errorMessage(reason)); return null; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (!admin) void establish(); }, [admin, establish]);
  return { admin, loading, error, establish };
}

function AdminHeader({ title }: { title?: string }) {
  return <header className="admin-header"><Brand compact /><div>{title && <span>{title}</span>}<a href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>Participant view ↗</a></div></header>;
}

function formatEdited(value?: string) {
  if (!value) return 'Recently edited';
  return `Edited ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))}`;
}

function GameLibrary() {
  const identity = useAdminIdentity();
  const admin = identity.admin;
  const establishAdmin = identity.establish;
  const [games, setGames] = useState<readonly GameSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hostOperation, setHostOperation] = useState<{ gameId: string; operation: SessionCreationOperation } | null>(null);
  const refresh = useCallback(async () => {
    if (!admin) return;
    setLoading(true); setError(null);
    try { setGames(await listGames(admin.token)); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) { adminSession.clear(); await establishAdmin(true); }
      else setError(errorMessage(reason));
    } finally { setLoading(false); }
  }, [admin, establishAdmin]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function host(game: GameSummary) {
    if (!identity.admin || busy) return;
    setBusy(game.id); setError(null);
    try {
      const operation = hostOperation?.gameId === game.id ? hostOperation.operation : newSessionOperation();
      setHostOperation({ gameId: game.id, operation });
      const response = await createGameRoom(game.id, identity.admin.token, operation);
      const next: HostSession = { ...response.room, token: response.hostToken };
      setHostOperation(null); hostSession.set(next); navigate(`/host/${next.code}`);
    } catch (reason) { setError(errorMessage(reason)); setBusy(null); }
  }

  async function remove(game: GameSummary) {
    if (!identity.admin || !window.confirm(`Delete “${game.name}”? This cannot be undone.`)) return;
    setBusy(game.id); setError(null);
    try { await deleteGame(game.id, identity.admin.token); await refresh(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }

  if (identity.loading || (!identity.admin && !identity.error)) return <main className="admin-shell"><Spinner label="Opening your game library" /></main>;
  return <main className="admin-shell">
    <AdminHeader title="Game library" />
    <section className="library-hero"><div><p className="eyebrow">Your episodes</p><h1>Pick the next mystery.</h1><p>Create a reusable game once, then host a fresh room whenever the team is ready.</p></div><a className="button button--hot" href="/host/games/new" onClick={(event) => { event.preventDefault(); navigate('/host/games/new'); }}>Create new game <span>＋</span></a></section>
    {(identity.error || error) && <Notice tone="error">{identity.error ?? error}</Notice>}
    {loading ? <Spinner label="Loading saved games" /> : <section className="game-grid">
      <a className="new-game-card" href="/host/games/new" onClick={(event) => { event.preventDefault(); navigate('/host/games/new'); }}><span>＋</span><strong>Create a new mystery</strong><small>Build your first question</small></a>
      {games.map((game, index) => <article className="game-poster" key={game.id}>
        <div className={`poster-art poster-art--${index % 4}`}><span>Episode {String(index + 1).padStart(2, '0')}</span><div><i /><i /><i /></div><b>?</b></div>
        <div className="poster-copy"><p>{game.questionCount} question{game.questionCount === 1 ? '' : 's'} · {formatEdited(game.updatedAt)}</p><h2>{game.name}</h2><div><button className="button button--hot" disabled={busy === game.id} onClick={() => { void host(game); }}>{busy === game.id ? 'Opening…' : 'Host now'} <span>→</span></button><a href={`/host/games/${game.id}/edit`} onClick={(event) => { event.preventDefault(); navigate(`/host/games/${game.id}/edit`); }}>Edit</a><button className="text-button danger" onClick={() => { void remove(game); }}>Delete</button></div></div>
      </article>)}
    </section>}
  </main>;
}

interface DraftChoice { clientId: string; id?: string; text: string; isCorrect: boolean }
interface DraftQuestion {
  clientId: string; id?: string; prompt: string; revealName: string; funFact: string;
  mysteryMediaAssetId: string | null; revealMediaAssetId: string | null;
  mysteryMediaPreviewUrl?: string | null; revealMediaPreviewUrl?: string | null;
  mysteryPreviewObjectUrl?: string | null; revealPreviewObjectUrl?: string | null;
  mysteryFile?: File; revealFile?: File; mediaDirty?: boolean; choices: DraftChoice[];
}
const uid = () => crypto.randomUUID();
const newQuestion = (): DraftQuestion => ({ clientId: uid(), prompt: 'Who is this team member?', revealName: '', funFact: '', mysteryMediaAssetId: null, revealMediaAssetId: null, choices: [{ clientId: uid(), text: '', isCorrect: true }, { clientId: uid(), text: '', isCorrect: false }] });
function toDraft(question: GameQuestionDefinition): DraftQuestion { return { ...question, funFact: question.funFact ?? '', clientId: uid(), choices: question.choices.map((choice) => ({ ...choice, clientId: uid() })) }; }
function serializeQuestion(question: DraftQuestion): GameQuestionDefinition { return { ...(question.id ? { id: question.id } : {}), prompt: question.prompt.trim(), revealName: question.revealName.trim(), funFact: question.funFact.trim() || null, mysteryMediaAssetId: question.mysteryMediaAssetId, revealMediaAssetId: question.revealMediaAssetId, choices: question.choices.map((choice) => ({ ...(choice.id ? { id: choice.id } : {}), text: choice.text.trim(), isCorrect: choice.isCorrect })) }; }

function GameEditor({ gameId }: { gameId?: string }) {
  const identity = useAdminIdentity();
  const [name, setName] = useState('');
  const [revision, setRevision] = useState(1);
  const [questions, setQuestions] = useState<DraftQuestion[]>([newQuestion()]);
  const [active, setActive] = useState(0);
  const [previewReveal, setPreviewReveal] = useState(false);
  const [loading, setLoading] = useState(Boolean(gameId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState(gameId);
  const [createdDraftId, setCreatedDraftId] = useState<string | null>(null);
  const [published, setPublished] = useState(Boolean(gameId));

  useEffect(() => {
    if (!gameId || !identity.admin) return;
    const adminToken = identity.admin.token;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const game = await getGame(gameId, adminToken);
        const draft = game.questions.map(toDraft);
        await Promise.all(draft.map(async (question) => {
          await Promise.all([
            (async () => {
              if (!question.mysteryMediaPreviewUrl) return;
              try {
                const blob = await loadGameMediaBlob(question.mysteryMediaPreviewUrl, adminToken);
                question.mysteryFile = new File([blob], 'saved-mystery', { type: blob.type || 'image/png' });
                question.mysteryPreviewObjectUrl = URL.createObjectURL(blob);
              } catch { question.mysteryPreviewObjectUrl = null; }
            })(),
            (async () => {
              if (!question.revealMediaPreviewUrl) return;
              try {
                const blob = await loadGameMediaBlob(question.revealMediaPreviewUrl, adminToken);
                question.revealFile = new File([blob], 'saved-reveal', { type: blob.type || 'image/png' });
                question.revealPreviewObjectUrl = URL.createObjectURL(blob);
              } catch { question.revealPreviewObjectUrl = null; }
            })(),
          ]);
        }));
        if (!cancelled) { setName(game.name); setRevision(game.revision); setQuestions(draft.length ? draft : [newQuestion()]); }
      } catch (reason) { if (!cancelled) setError(errorMessage(reason)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [gameId, identity.admin]);

  function updateQuestion(index: number, update: (question: DraftQuestion) => DraftQuestion) { setQuestions((items) => items.map((question, i) => i === index ? update(question) : question)); }
  async function selectImage(kind: 'mystery' | 'reveal', event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    if (!imageTypes.includes(file.type)) { setError('Use a JPG, PNG, or WebP image.'); event.target.value = ''; return; }
    if (file.size > MAX_IMAGE_BYTES) { setError('Images must be 5 MB or smaller.'); event.target.value = ''; return; }
    setError(null); setSaveNote(`Preparing ${kind} image preview…`);
    try {
      const normalizedFile = await normalizeUpload(file);
      updateQuestion(active, (question) => {
        const previous = kind === 'mystery' ? question.mysteryPreviewObjectUrl : question.revealPreviewObjectUrl;
        if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
        return kind === 'mystery'
          ? { ...question, mysteryFile: normalizedFile, mysteryPreviewObjectUrl: URL.createObjectURL(normalizedFile), mediaDirty: true }
          : { ...question, revealFile: normalizedFile, revealPreviewObjectUrl: URL.createObjectURL(normalizedFile), mediaDirty: true };
      });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaveNote(null); }
  }
  function moveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction; if (target < 0 || target >= questions.length) return;
    setQuestions((items) => { const next = [...items]; const current = next[index]; const destination = next[target]; if (!current || !destination) return items; next[index] = destination; next[target] = current; return next; }); setActive(target);
  }
  function removeQuestion(index: number) {
    if (questions.length === 1) return;
    setQuestions((items) => items.filter((_, i) => i !== index)); setActive((value) => Math.max(0, Math.min(value, questions.length - 2)));
  }
  function addChoice() { updateQuestion(active, (question) => question.choices.length >= 10 ? question : { ...question, choices: [...question.choices, { clientId: uid(), text: '', isCorrect: false }] }); }
  function removeChoice(index: number) { updateQuestion(active, (question) => { if (question.choices.length <= 2) return question; const removed = question.choices[index]; if (!removed) return question; const choices = question.choices.filter((_, i) => i !== index); const first = choices[0]; if (removed.isCorrect && first) choices[0] = { ...first, isCorrect: true }; return { ...question, choices }; }); }
  function validate() {
    if (!name.trim()) return 'Give this game a name.';
    for (const [index, question] of questions.entries()) {
      if (!question.prompt.trim() || !question.revealName.trim()) return `Finish the prompt and reveal name for question ${index + 1}.`;
      if (!question.mysteryMediaAssetId && !question.mysteryFile) return `Add a Mystery Image to question ${index + 1}.`;
      if (!question.revealMediaAssetId && !question.revealFile) return `Add a Reveal Image to question ${index + 1}.`;
      if (question.funFact.length > 500) return `Shorten the Fun Fact for question ${index + 1} to 500 characters.`;
      if (question.choices.some((choice) => !choice.text.trim())) return `Finish every answer in question ${index + 1}.`;
      if (question.choices.filter((choice) => choice.isCorrect).length !== 1) return `Choose one correct answer for question ${index + 1}.`;
    }
    return null;
  }
  async function save() {
    if (!identity.admin || saving) return;
    const validation = validate(); if (validation) { setError(validation); return; }
    setSaving(true); setError(null); setSaveNote('Saving the game definition…');
    try {
      let game: GameDefinition;
      if (!currentId) {
        game = await createGame(identity.admin.token, { name: name.trim(), questions: [] });
        setCurrentId(game.id); setCreatedDraftId(game.id); setRevision(game.revision); history.replaceState({}, '', `/host/games/${game.id}/edit`);
      } else game = { id: currentId, name: name.trim(), revision, questions: questions.map(serializeQuestion) };
      const nextQuestions = [...questions];
      for (let index = 0; index < nextQuestions.length; index += 1) {
        const question = nextQuestions[index]; if (!question?.mediaDirty) continue;
        if (!question.mysteryFile || !question.revealFile) throw new Error(`Question ${index + 1} needs both its Mystery Image and Reveal Image.`);
        setSaveNote(`Uploading image pair ${index + 1} of ${questions.length}…`);
        const media = await uploadGameMedia(game.id, identity.admin.token, question.mysteryFile, question.revealFile);
        const mysteryMediaAssetId = media.mysteryMediaAssetId ?? media.id;
        const revealMediaAssetId = media.revealMediaAssetId ?? media.id;
        if (!mysteryMediaAssetId || !revealMediaAssetId) throw new Error('The image upload did not return both media references.');
        nextQuestions[index] = { ...question, mysteryMediaAssetId, revealMediaAssetId, mysteryMediaPreviewUrl: media.mysteryPreviewUrl, revealMediaPreviewUrl: media.revealPreviewUrl, mediaDirty: false };
      }
      setSaveNote('Publishing your latest edits…');
      const saved = await updateGame(identity.admin.token, { id: game.id, name: name.trim(), revision: game.revision, questions: nextQuestions.map(serializeQuestion) });
      setRevision(saved.revision); setPublished(true); setCreatedDraftId(null);
      setQuestions(saved.questions.map((savedQuestion, index) => ({ ...toDraft(savedQuestion), ...(nextQuestions[index]?.mysteryFile ? { mysteryFile: nextQuestions[index].mysteryFile } : {}), ...(nextQuestions[index]?.revealFile ? { revealFile: nextQuestions[index].revealFile } : {}), mysteryPreviewObjectUrl: nextQuestions[index]?.mysteryPreviewObjectUrl ?? null, revealPreviewObjectUrl: nextQuestions[index]?.revealPreviewObjectUrl ?? null })));
      setSaveNote('Saved'); window.setTimeout(() => setSaveNote(null), 1600);
    } catch (reason) { setError(errorMessage(reason)); setSaveNote(null); }
    finally { setSaving(false); }
  }

  async function cancel(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (createdDraftId && !published && identity.admin) {
      try { await deleteGame(createdDraftId, identity.admin.token); } catch { /* The draft remains visible in My Games for recovery. */ }
    }
    navigate('/host');
  }

  if (identity.loading || loading) return <main className="admin-shell"><Spinner label="Opening the editor studio" /></main>;
  const question = questions[active];
  if (!question) return <main className="admin-shell error-page"><Notice tone="error">The selected question could not be opened.</Notice></main>;
  return <main className="admin-shell editor-shell"><AdminHeader title={gameId ? 'Edit game' : 'New game'} />
    <section className="editor-topbar"><a href="/host" onClick={(event) => { void cancel(event); }}>← My games</a><label>Game name<input aria-label="Game name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Summer Team Ice Breaker" /></label><div>{saveNote && <span className="save-note">{saveNote}</span>}<button className="button button--hot" disabled={saving} onClick={() => { void save(); }}>{saving ? 'Saving…' : 'Save game'} <span>→</span></button></div></section>
    {(identity.error || error) && <Notice tone="error">{identity.error ?? error}</Notice>}
    <div className="editor-layout">
      <aside className="question-rail"><header><p className="eyebrow">Run of show</p><strong>{questions.length} question{questions.length === 1 ? '' : 's'}</strong></header>{questions.map((item, index) => <button className={index === active ? 'is-active' : ''} key={item.clientId} onClick={() => setActive(index)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.revealName || 'Untitled mystery'}</strong><small>{item.choices.length} answers</small></div></button>)}<button className="add-question" onClick={() => { setQuestions((items) => [...items, newQuestion()]); setActive(questions.length); }}>＋ Add question</button></aside>
      <section className="question-editor angle-panel"><header><div><p className="eyebrow">Question {active + 1}</p><h2>Build the mystery</h2></div><div className="reorder-controls"><button aria-label="Move question up" disabled={active === 0} onClick={() => moveQuestion(active, -1)}>↑</button><button aria-label="Move question down" disabled={active === questions.length - 1} onClick={() => moveQuestion(active, 1)}>↓</button><button className="danger" disabled={questions.length === 1} onClick={() => removeQuestion(active)}>Remove</button></div></header>
        <div className="field-grid"><label>Question prompt<input value={question.prompt} onChange={(event) => updateQuestion(active, (item) => ({ ...item, prompt: event.target.value }))} maxLength={160} /></label><label>Employee / reveal name<input value={question.revealName} onChange={(event) => updateQuestion(active, (item) => ({ ...item, revealName: event.target.value }))} maxLength={100} placeholder="Priya Shah" /></label></div>
        <label className="fun-fact-field">Fun Fact (optional)<textarea value={question.funFact} onChange={(event) => updateQuestion(active, (item) => ({ ...item, funFact: event.target.value }))} maxLength={500} rows={3} placeholder="Has visited 17 countries." /><small>{question.funFact.length} / 500</small></label>
        <div className="image-pair-editor">
          <div className="image-upload"><div>{question.mysteryPreviewObjectUrl ? <img src={question.mysteryPreviewObjectUrl} alt="Mystery Image preview" /> : <span>Mystery<br />preview</span>}</div><label><strong>Mystery Image</strong><span>{question.mysteryMediaAssetId || question.mysteryFile ? 'Replace mystery image' : 'Add mystery image'}</span><small>Shown while players guess · JPG, PNG, or WebP · up to 5 MB</small><input aria-label="Mystery Image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { void selectImage('mystery', event); }} /></label></div>
          <div className="image-upload"><div>{question.revealPreviewObjectUrl ? <img src={question.revealPreviewObjectUrl} alt="Reveal Image preview" /> : <span>Reveal<br />preview</span>}</div><label><strong>Reveal Image</strong><span>{question.revealMediaAssetId || question.revealFile ? 'Replace reveal image' : 'Add reveal image'}</span><small>Shown only after Reveal · JPG, PNG, or WebP · up to 5 MB</small><input aria-label="Reveal Image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { void selectImage('reveal', event); }} /></label></div>
        </div>
        <div className="answers-editor"><header><div><h3>Answer choices</h3><p>Pick the radio button beside the correct answer.</p></div><button disabled={question.choices.length >= 10} onClick={addChoice}>＋ Add answer</button></header>{question.choices.map((choice, index) => <div className="answer-row" key={choice.clientId}><span>{choiceMarks[index]}</span><input type="radio" aria-label={`Mark answer ${index + 1} correct`} name={`correct-${question.clientId}`} checked={choice.isCorrect} onChange={() => updateQuestion(active, (item) => ({ ...item, choices: item.choices.map((entry, i) => ({ ...entry, isCorrect: i === index })) }))} /><input aria-label={`Answer ${index + 1}`} value={choice.text} onChange={(event) => updateQuestion(active, (item) => ({ ...item, choices: item.choices.map((entry, i) => i === index ? { ...entry, text: event.target.value } : entry) }))} maxLength={100} placeholder={index === 0 ? question.revealName || 'Correct name' : 'Another teammate'} /><button aria-label={`Remove answer ${index + 1}`} disabled={question.choices.length <= 2} onClick={() => removeChoice(index)}>×</button></div>)}</div>
      </section>
      <aside className="preview-studio"><header><div><p className="eyebrow">Live preview</p><strong>{previewReveal ? 'Reveal' : 'Mystery'}</strong></div><div className="segmented"><button className={!previewReveal ? 'is-active' : ''} onClick={() => setPreviewReveal(false)}>Mystery</button><button className={previewReveal ? 'is-active' : ''} onClick={() => setPreviewReveal(true)}>Reveal</button></div></header><div className="preview-stage"><PortraitChamber src={previewReveal ? question.revealPreviewObjectUrl : question.mysteryPreviewObjectUrl} revealed={previewReveal} name={question.revealName || 'Teammate'} /><p>{previewReveal ? 'Say hello to' : question.prompt || 'Who is this team member?'}</p><h3>{previewReveal ? question.revealName || 'Employee name' : 'Who could it be?'}</h3>{previewReveal && question.funFact.trim() && <blockquote className="preview-fun-fact">{question.funFact.trim()}</blockquote>}</div><p className="preview-help">Mystery and Reveal images are separate. Players see the Mystery Image until the host reveals the teammate.</p></aside>
    </div>
  </main>;
}

const actionForPhase: Partial<Record<GamePhase, { action: HostAction; label: string; hint: string }>> = {
  lobby: { action: 'start', label: 'Start round', hint: 'Open voting on every phone' },
  question_open: { action: 'lock', label: 'Lock answers', hint: 'Close voting when the room is ready' },
  answers_locked: { action: 'reveal', label: 'Reveal teammate', hint: 'Fire the reveal on every screen' },
  employee_revealed: { action: 'show_results', label: 'Show results', hint: 'See how the room voted' },
  results_displayed: { action: 'next_round', label: 'Next round', hint: 'Cue the next mystery' },
};

function HostDashboard({ session }: { session: HostSession }) {
  const room = useRoomSnapshot(session.code);
  const [busy, setBusy] = useState<HostAction | 'play_again' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostRoom, setHostRoom] = useState<Awaited<ReturnType<typeof getHostRoom>>['host'] | null>(null);
  const [verified, setVerified] = useState(false);
  const [replayOperation, setReplayOperation] = useState<SessionCreationOperation | null>(null);
  const verify = useCallback(async () => {
    try { const payload = await getHostRoom(session.code, session.token); setHostRoom(payload.host); setVerified(true); }
    catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) { hostSession.clear(); navigate('/host'); return; }
      setError(errorMessage(reason));
    }
  }, [session.code, session.token]);
  useEffect(() => { void verify(); }, [verify]);
  async function act(action: HostAction) {
    if (busy) return; setBusy(action); setError(null);
    try { await performDirectHostAction(session.code, session.token, action); await room.refetch(true, 'transition'); await verify(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }
  async function replay() {
    if (busy) return; setBusy('play_again'); setError(null);
    try {
      const operation = replayOperation ?? newSessionOperation(); setReplayOperation(operation);
      const response = await playAgain(session.code, session.token, operation);
      const next: HostSession = { ...response.room, token: response.hostToken };
      setReplayOperation(null); setBusy(null); hostSession.set(next); navigate(`/host/${next.code}`);
    }
    catch (reason) { setError(errorMessage(reason)); setBusy(null); }
  }
  if (!verified && !error) return <main className="host-shell"><Spinner label="Opening the control room" /></main>;
  if (!verified) return <main className="host-shell error-page"><Brand /><h1>Your host session is still here.</h1><Notice tone="error">{error}</Notice><button className="button button--light" onClick={() => { setError(null); void verify(); }}>Try again</button></main>;
  if (room.loading && !room.snapshot) return <main className="host-shell"><Spinner label="Syncing the control room" /></main>;
  if (!room.snapshot) return <main className="host-shell error-page"><Notice tone="error">{room.error ?? 'Could not open this room.'}</Notice></main>;
  const snapshot = room.snapshot;
  const isFinalRound = hostRoom?.isFinalRound ?? ((snapshot.roundIndex ?? -1) + 1 >= snapshot.roundCount);
  const next = snapshot.phase === 'results_displayed' && isFinalRound ? { action: 'end' as const, label: 'Finish game', hint: 'Close with the finale' } : actionForPhase[snapshot.phase];
  return <main className={`host-shell host-phase-${snapshot.phase}`}><header className="host-header"><Brand compact /><nav><a href="/host" onClick={(event) => { event.preventDefault(); navigate('/host'); }}>My games</a><span className="phase-chip">{phaseLabels[snapshot.phase]}</span><strong>{session.code}</strong></nav></header>{(room.offline || room.error) && <div className="connection-banner">Connection interrupted — controls will resume automatically.</div>}
    <div className="control-layout"><section className="control-main"><header><div><p className="eyebrow">{session.gameName ?? hostRoom?.gameName ?? 'Live mystery'}</p><h1>{snapshot.phase === 'lobby' ? 'The room is open.' : snapshot.phase === 'complete' ? 'That’s a wrap.' : `Round ${(snapshot.roundIndex ?? 0) + 1} of ${snapshot.roundCount}`}</h1></div><div className="room-code"><span>Room code</span><strong>{session.code}</strong></div></header><div className="control-metrics"><article><strong>{snapshot.connectedParticipantCount}</strong><span>Players</span></article><article><strong>{snapshot.submittedAnswerCount}<i>/{answerDenominator(snapshot)}</i></strong><span>Eligible answers</span></article><article><strong>{snapshot.roundIndex === null ? '—' : snapshot.roundIndex + 1}<i>/{snapshot.roundCount}</i></strong><span>Round</span></article></div><section className="round-monitor"><header><h2>Stage monitor</h2><span>{phaseLabels[snapshot.phase]}</span></header>{snapshot.phase === 'lobby' ? <div className="monitor-empty"><PortraitChamber compact /><p>The first teammate is waiting behind the curtain.</p></div> : <div className="monitor-choices">{snapshot.choices.map((choice, index) => <div className={snapshot.revealedEmployee?.id === choice.id ? 'is-correct' : ''} key={choice.id}><b>{choiceMarks[index]}</b><span>{choice.displayName}</span>{snapshot.revealedEmployee?.id === choice.id && <em>Correct</em>}</div>)}</div>}{hostRoom?.correctEmployee && snapshot.phase !== 'complete' && <div className="host-answer"><span>Host answer</span><strong>{hostRoom.correctEmployee.displayName}</strong></div>}</section></section>
      <aside className="control-sidebar">{snapshot.phase === 'complete' ? <section className="next-cue finale-control"><span className="finale-burst">★</span><p className="eyebrow">Fresh room, same game</p><h2>Ready for another run?</h2><p>Replay starts a clean session with a new code and no previous players or answers.</p><button className="button button--hot button--block" disabled={Boolean(busy)} onClick={() => { void replay(); }}>{busy === 'play_again' ? 'Creating room…' : 'Play again'} <span>↻</span></button><a className="button button--ghost button--block" href="/host" onClick={(event) => { event.preventDefault(); navigate('/host'); }}>My games</a></section> : <section className="next-cue"><p className="eyebrow">Next cue</p><h2>{next?.label}</h2><p>{next?.hint}</p>{next && <button className="button button--hot button--block" disabled={Boolean(busy) || room.offline} onClick={() => { void act(next.action); }}>{busy ? 'Working…' : next.label} <span>→</span></button>}</section>}{error && <Notice tone="error">{error}</Notice>}<section className="share-card"><p className="eyebrow">Audience links</p><a href={`/display/${session.code}`} target="_blank" rel="noreferrer">Open shared display <span>↗</span></a><button onClick={() => { void navigator.clipboard.writeText(`${location.origin}/join/${session.code}`); }}>Copy join link <span>⧉</span></button></section></aside></div>
  </main>;
}

function HostRoute({ code }: { code: string }) {
  const session = hostSession.get();
  if (!session || session.code !== code) return <main className="host-shell error-page"><Brand /><h1>This control room isn’t on this device.</h1><p>Return to your game library and host a fresh session.</p><a className="button button--light" href="/host">My games</a></main>;
  return <HostDashboard session={session} />;
}

function Display({ code }: { code: string }) {
  const room = useRoomSnapshot(code);
  useEffect(() => () => releaseRoomAssets(code), [code]);
  useEffect(() => { preloadAssets(room.snapshot?.preloadAssets); }, [room.snapshot?.preloadAssets]);
  const mysterySrc = useMysteryImage(room.snapshot?.roundIndex ?? null, room.snapshot?.preloadAssets, room.snapshot?.mysteryImageUrl ?? room.snapshot?.silhouetteUrl);
  if (room.loading && !room.snapshot) return <main className="display-shell"><Spinner /></main>;
  if (!room.snapshot) return <main className="display-shell display-center"><h1>Room not found</h1><p>{room.error}</p></main>;
  const snapshot = room.snapshot; const reveal = snapshot.revealedEmployee; const joinUrl = `${location.origin}/join/${code}`;
  return <main className={`display-shell display-state-${snapshot.phase}`}><header className="display-header"><Brand compact /><div>{snapshot.phase !== 'complete' && <span className="live-dot">Live</span>}{snapshot.phase !== 'lobby' && snapshot.phase !== 'complete' && <strong>Round {(snapshot.roundIndex ?? 0) + 1} / {snapshot.roundCount}</strong>}</div></header>{room.offline && <div className="connection-banner">Display offline — reconnecting automatically</div>}
    {snapshot.phase === 'lobby' && <section className="display-lobby"><div><p className="eyebrow">The studio is open</p><h1>Gather the <em>crew.</em></h1><p>Scan the code. Pick a player name. Get ready for the first mystery.</p><div className="audience-meter"><i /><strong>{snapshot.connectedParticipantCount}</strong><span>player{snapshot.connectedParticipantCount === 1 ? '' : 's'} in the audience</span></div></div><div className="join-board angle-panel"><span>Join on your phone</span><div className="qr"><QRCodeSVG value={joinUrl} size={240} level="M" marginSize={2} title={`Scan to join room ${code}`} /></div><p>{location.host}</p><strong>{code}</strong></div></section>}
    {snapshot.phase === 'question_open' && <section className="display-question"><PortraitChamber src={mysterySrc} /><div><p className="eyebrow">Mystery {(snapshot.roundIndex ?? 0) + 1}</p><h1>{snapshot.prompt ?? 'Who is this team member?'}</h1><div className="display-choices">{snapshot.choices.map((choice, index) => <div key={choice.id}><b>{choiceMarks[index]}</b><span>{choice.displayName}</span></div>)}</div><div className="answer-meter"><i><b style={{ width: `${answerDenominator(snapshot) ? (snapshot.submittedAnswerCount / answerDenominator(snapshot)) * 100 : 0}%` }} /></i><strong>{snapshot.submittedAnswerCount} / {answerDenominator(snapshot)}</strong><span>eligible answers locked in</span></div></div></section>}
    {snapshot.phase === 'answers_locked' && <section className="display-locked"><PortraitChamber src={mysterySrc} /><div className="lock-slam"><span>Locked in</span><h1>The room has spoken.</h1><p>Stand by for the reveal.</p></div></section>}
    {(snapshot.phase === 'employee_revealed' || snapshot.phase === 'results_displayed') && reveal && <section className="display-reveal"><RoomRevealPortrait code={code} reveal={reveal} assets={snapshot.preloadAssets} /><div><p className="eyebrow">Mystery solved</p><h1>{reveal.displayName}</h1>{reveal.team && <h2>{reveal.team}</h2>}{reveal.funFact && <blockquote>“{reveal.funFact}”</blockquote>}{snapshot.phase === 'results_displayed' && <Results snapshot={snapshot} large />}</div></section>}
    {snapshot.phase === 'complete' && <section className="display-complete"><div className="finale-burst">★</div><p className="eyebrow">Final curtain</p><h1>You know the crew.<br /><em>Now make some memories.</em></h1><p>{snapshot.roundCount} mysteries revealed · Thanks for playing.</p></section>}
    <footer className="display-footer"><span>Name That Team Member</span><span>{snapshot.phase === 'complete' ? 'Show complete' : `Room ${code}`}</span></footer></main>;
}

function NotFound() { return <main className="error-page"><Brand /><h1>That scene isn’t in the show.</h1><a className="button button--light" href="/">Go home</a></main>; }

export function App() {
  const path = usePath();
  const join = path.match(/^\/join\/([A-Z2-9]{5})$/i); const play = path.match(/^\/play\/([A-Z2-9]{5})$/i); const display = path.match(/^\/display\/([A-Z2-9]{5})$/i); const host = path.match(/^\/host\/([A-Z2-9]{5})$/i); const edit = path.match(/^\/host\/games\/([^/]+)\/edit$/);
  if (join?.[1]) return <Join key={`join:${join[1].toUpperCase()}`} code={join[1].toUpperCase()} />;
  if (play?.[1]) return <ParticipantRoute key={`play:${play[1].toUpperCase()}`} code={play[1].toUpperCase()} />;
  if (display?.[1]) return <Display key={`display:${display[1].toUpperCase()}`} code={display[1].toUpperCase()} />;
  if (path === '/host/games/new') return <GameEditor />;
  if (edit?.[1]) return <GameEditor gameId={edit[1]} />;
  if (host?.[1]) return <HostRoute code={host[1].toUpperCase()} />;
  if (path === '/host') return <GameLibrary />;
  if (path === '/') return <Home />;
  return <NotFound />;
}
