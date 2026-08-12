import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Choice, GamePhase, GameSnapshot, HostAction } from './domain/game';
import { phaseLabels } from './domain/game';
import { useRoomSnapshot } from './hooks/useRoomSnapshot';
import { ApiError, createRoom, errorMessage, getHostRoom, joinRoom, performHostAction, submitAnswer } from './lib/api';
import { hostSession, participantSession, type HostSession, type ParticipantSession } from './lib/session';

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}$/;
const choiceMarks = ['A', 'B', 'C', 'D'];

function navigate(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <a className={`brand ${compact ? 'brand--compact' : ''}`} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
    <span className="brand__spark" aria-hidden="true">✦</span>
    <span>Name That<br /><strong>Team Member</strong></span>
  </a>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

function Spinner({ label = 'Loading game' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

function MysteryPortrait({ large = false }: { large?: boolean }) {
  return <div className={`mystery-portrait ${large ? 'mystery-portrait--large' : ''}`} aria-label="Mystery teammate portrait concealed until the reveal">
    <span className="mystery-portrait__head" aria-hidden="true" />
    <span className="mystery-portrait__shoulders" aria-hidden="true" />
    <strong aria-hidden="true">?</strong>
  </div>;
}

function Home() {
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
  return <main className="home-shell">
    <header className="home-header"><Brand /><a href="/host" onClick={(e) => { e.preventDefault(); navigate('/host'); }}>Host a game <span>→</span></a></header>
    <section className="home-hero">
      <div className="home-copy">
        <p className="kicker">Faces you know. Stories you don’t.</p>
        <h1>How well do you know your crew?</h1>
        <p className="lede">Join the live team game where every reveal starts a better conversation.</p>
      </div>
      <form className="join-card" onSubmit={(e) => { e.preventDefault(); if (CODE_PATTERN.test(clean)) navigate(`/join/${clean}`); }}>
        <span className="join-card__number" aria-hidden="true">01</span>
        <h2>Join the room</h2>
        <label htmlFor="room-code">Enter the 5-character code</label>
        <input id="room-code" className="code-input" value={clean} onChange={(e) => setCode(e.target.value)} placeholder="F7K2M" autoComplete="off" autoCapitalize="characters" maxLength={5} />
        <button className="button button--primary button--block" disabled={!CODE_PATTERN.test(clean)}>Let’s play <span aria-hidden="true">→</span></button>
      </form>
    </section>
    <footer className="home-footer"><span>Designed for teams, built for connection.</span><span>Works great on your phone.</span></footer>
  </main>;
}

function Join({ code }: { code: string }) {
  const existing = participantSession.get(code);
  const [name, setName] = useState(existing?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (existing) navigate(`/play/${code}`); }, [code, existing]);

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await joinRoom(code, name.trim());
      participantSession.set({ ...response.participant, code, token: response.participantToken });
      navigate(`/play/${code}`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return <main className="join-page">
    <header><Brand compact /><span className="room-pill">Room <strong>{code}</strong></span></header>
    <form className="name-card" onSubmit={(event) => { void handleJoin(event); }}>
      <div className="step-orbit" aria-hidden="true"><span>02</span></div>
      <p className="kicker">You’re in the right place</p>
      <h1>What should we call you?</h1>
      <p>This name will appear on the host screen.</p>
      <label htmlFor="display-name">Your display name</label>
      <input id="display-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={40} placeholder="e.g. Alex" autoFocus />
      {error && <Notice tone="error">{error}</Notice>}
      <button className="button button--primary button--block" disabled={busy || !name.trim()}>{busy ? 'Joining…' : 'Enter game'} <span aria-hidden="true">→</span></button>
      <small>No account needed. Just you and your team.</small>
    </form>
  </main>;
}

function RoundHeader({ snapshot, name }: { snapshot: GameSnapshot; name?: string }) {
  const round = snapshot.roundIndex === null ? 0 : snapshot.roundIndex + 1;
  return <header className="game-header">
    <Brand compact />
    <div className="game-header__meta">
      {name && <span className="player-chip">{name}</span>}
      <span className="round-chip">Round {round} <i>/ {snapshot.roundCount}</i></span>
    </div>
  </header>;
}

function ParticipantGame({ code, session }: { code: string; session: ParticipantSession }) {
  const auth = useMemo(() => ({ token: session.token, playerId: session.playerId }), [session.playerId, session.token]);
  const room = useRoomSnapshot(code, auth);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const answerId = room.participantState?.answerEmployeeId ?? selected;

  useEffect(() => {
    if (room.snapshot?.phase === 'question_open' && !room.participantState?.answerEmployeeId) setSelected(null);
  }, [room.snapshot?.roundIndex, room.snapshot?.phase, room.participantState?.answerEmployeeId]);

  async function choose(choice: Choice) {
    if (answerId || room.snapshot?.phase !== 'question_open' || submitting) return;
    setSelected(choice.id); setSubmitting(true); setSubmitError(null);
    try { await submitAnswer(code, session.token, session.playerId, choice.id); await room.refetch(true); }
    catch (reason) { setSelected(null); setSubmitError(errorMessage(reason)); }
    finally { setSubmitting(false); }
  }

  if (room.loading && !room.snapshot) return <main className="participant-shell"><Spinner /></main>;
  if (!room.snapshot) return <main className="participant-shell error-page"><Brand compact /><h1>We lost the room</h1><Notice tone="error">{room.error ?? 'This game is not available.'}</Notice><button className="button button--secondary" onClick={() => { void room.refetch(); }}>Try again</button></main>;
  const snapshot = room.snapshot;
  const revealed = snapshot.revealedEmployee;
  const chosenName = snapshot.choices.find((choice) => choice.id === answerId)?.displayName;

  return <main className={`participant-shell phase-${snapshot.phase}`}>
    <RoundHeader snapshot={snapshot} name={session.displayName} />
    {(room.offline || room.error) && <div className="connection-banner" role="status">{room.offline ? 'You’re offline — we’ll reconnect automatically.' : 'Connection interrupted. Retrying…'}</div>}
    <section className="participant-stage" aria-live="polite">
      {snapshot.phase === 'lobby' && <div className="waiting-state">
        <div className="pulse-orbit" aria-hidden="true"><span>✓</span></div><p className="kicker">You’re all set</p><h1>Welcome, {session.displayName}!</h1><p>Hang tight — your host will start the first round.</p><div className="waiting-dots" aria-hidden="true"><i /><i /><i /></div>
      </div>}
      {snapshot.phase === 'question_open' && <div className="question-state">
        <div className="question-heading"><MysteryPortrait /><p className="kicker">Choose one</p><h1>Who is this team member?</h1><span>{answerId ? 'Answer submitted' : 'Tap your best guess'}</span></div>
        <div className="choice-grid">
          {snapshot.choices.map((choice, index) => <button key={choice.id} className={`choice ${answerId === choice.id ? 'choice--selected' : ''} ${answerId && answerId !== choice.id ? 'choice--muted' : ''}`} disabled={Boolean(answerId) || submitting} onClick={() => { void choose(choice); }}>
            <span className="choice__mark">{choiceMarks[index]}</span><span>{choice.displayName}</span>{answerId === choice.id && <span className="choice__check" aria-label="Selected">✓</span>}
          </button>)}
        </div>
        {submitError && <Notice tone="error">{submitError}</Notice>}
        {answerId && <Notice tone="success"><strong>Locked in: {chosenName}</strong><br />Your answer can’t be changed.</Notice>}
      </div>}
      {snapshot.phase === 'answers_locked' && <div className="waiting-state"><div className="lock-icon" aria-hidden="true">◆</div><p className="kicker">Answers locked</p><h1>{chosenName ? `You picked ${chosenName}.` : 'Time’s up!'}</h1><p>The big reveal is coming next.</p></div>}
      {(snapshot.phase === 'employee_revealed' || snapshot.phase === 'results_displayed') && revealed && <div className="reveal-state">
        <p className="kicker">Meet the teammate</p>
        <div className="reveal-card">
          <div className="portrait-frame">{revealed.mediaAvailable ? <img src={`/api/rooms/${code}/media/${revealed.id}`} alt={`Portrait of ${revealed.displayName}`} /> : <span aria-hidden="true">{revealed.displayName.slice(0, 1)}</span>}</div>
          <div><h1>{revealed.displayName}</h1>{revealed.team && <p className="team-line">{revealed.team}</p>}{revealed.funFact && <blockquote>“{revealed.funFact}”</blockquote>}</div>
        </div>
        {snapshot.phase === 'results_displayed' && snapshot.results && <Results snapshot={snapshot} />}
      </div>}
      {snapshot.phase === 'complete' && <div className="waiting-state complete-state"><div className="pulse-orbit"><span>✦</span></div><p className="kicker">That’s a wrap</p><h1>Thanks for playing!</h1><p>You know your team a little better now.</p></div>}
    </section>
    <footer className="participant-footer"><span>Room {code}</span><span className="live-dot">Live</span></footer>
  </main>;
}

function ParticipantRoute({ code }: { code: string }) {
  const session = participantSession.get(code);
  useEffect(() => { if (!session) navigate(`/join/${code}`); }, [code, session]);
  return session ? <ParticipantGame code={code} session={session} /> : <main className="participant-shell"><Spinner /></main>;
}

function Results({ snapshot, large = false }: { snapshot: GameSnapshot; large?: boolean }) {
  if (!snapshot.results) return null;
  const max = Math.max(1, ...snapshot.results.choices.map((item) => item.count));
  const correct = snapshot.revealedEmployee?.id;
  return <section className={`results ${large ? 'results--large' : ''}`} aria-label="Answer results">
    <div className="results__headline"><strong>{snapshot.results.correctAnswers}</strong><span>of {snapshot.results.totalAnswers} got it right</span></div>
    <div className="result-bars">{snapshot.results.choices.map((item) => {
      const choice = snapshot.choices.find((entry) => entry.id === item.employeeId);
      return <div className={`result-row ${item.employeeId === correct ? 'result-row--correct' : ''}`} key={item.employeeId}>
        <div><span>{choice?.displayName ?? 'Choice'}{item.employeeId === correct && <em className="result-row__correct"><b aria-hidden="true">✓</b> Correct</em>}</span><strong>{item.count}</strong></div><i><b style={{ width: `${(item.count / max) * 100}%` }} /></i>
      </div>;
    })}</div>
  </section>;
}

const actionForPhase: Partial<Record<GamePhase, { action: HostAction; label: string; hint: string }>> = {
  lobby: { action: 'start', label: 'Start round', hint: 'Open voting for everyone' },
  question_open: { action: 'lock', label: 'Lock answers', hint: 'Stop accepting responses' },
  answers_locked: { action: 'reveal', label: 'Reveal teammate', hint: 'Show the answer everywhere' },
  employee_revealed: { action: 'show_results', label: 'Show results', hint: 'Share how the room voted' },
  results_displayed: { action: 'next_round', label: 'Next round', hint: 'Move to the next teammate' },
};

function Host() {
  const [session, setSession] = useState<HostSession | null>(() => hostSession.get());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidateHost = useCallback(() => { hostSession.clear(); setSession(null); }, []);
  useEffect(() => {
    const match = location.pathname.match(/^\/host\/([A-Z2-9]{5})$/);
    const stored = hostSession.get();
    if (match?.[1] && stored?.code !== match[1]) setSession(null);
  }, []);

  async function create() {
    setCreating(true); setError(null);
    try {
      const response = await createRoom();
      const next = { roomId: response.room.roomId, code: response.room.code, token: response.hostToken };
      hostSession.set(next); setSession(next); navigate(`/host/${next.code}`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setCreating(false); }
  }

  if (!session) return <main className="host-start">
    <header><Brand /><a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Participant view</a></header>
    <section><p className="kicker">Host control</p><h1>Bring your team together.</h1><p>Create a private room, share one code, and lead every beat from here.</p>{error && <Notice tone="error">{error}</Notice>}<button className="button button--primary" disabled={creating} onClick={() => { void create(); }}>{creating ? 'Creating room…' : 'Create a new game'} <span>→</span></button></section>
  </main>;
  return <HostDashboard session={session} onInvalid={invalidateHost} />;
}

function HostDashboard({ session, onInvalid }: { session: HostSession; onInvalid: () => void }) {
  const room = useRoomSnapshot(session.code);
  const [busy, setBusy] = useState<HostAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [hostRoom, setHostRoom] = useState<Awaited<ReturnType<typeof getHostRoom>>['host'] | null>(null);
  const verifyHost = useCallback(async () => {
    setVerifying(true);
    setVerificationError(null);
    try {
      const { host } = await getHostRoom(session.code, session.token);
      setHostRoom(host);
      setVerified(true);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
        onInvalid();
        return;
      }
      setVerificationError(errorMessage(reason));
    } finally {
      setVerifying(false);
    }
  }, [session.code, session.token, onInvalid]);
  useEffect(() => {
    void verifyHost();
  }, [verifyHost]);
  const snapshot = room.snapshot;
  async function act(action: HostAction) {
    if (busy) return;
    if ((action === 'reveal' || action === 'end') && !window.confirm(action === 'reveal' ? 'Reveal the teammate on every screen?' : 'End this game for everyone?')) return;
    setBusy(action); setActionError(null);
    try {
      const response = await performHostAction(session.code, session.token, action);
      room.setSnapshot(response.snapshot);
      const { host } = await getHostRoom(session.code, session.token);
      setHostRoom(host);
    }
    catch (reason) { setActionError(errorMessage(reason)); }
    finally { setBusy(null); }
  }
  if (verifying && !verified) return <main className="host-shell"><Spinner label="Opening host controls" /></main>;
  if (verificationError && !verified) return <main className="host-shell error-page"><Brand compact /><h1>Your host session is still here.</h1><Notice tone="error">{verificationError}</Notice><button className="button button--secondary" onClick={() => { void verifyHost(); }}>Try again</button></main>;
  if (room.loading && !snapshot) return <main className="host-shell"><Spinner label="Opening host controls" /></main>;
  if (!snapshot) return <main className="host-shell"><Notice tone="error">{room.error ?? 'Could not open this room.'}</Notice></main>;
  const isFinalRound = hostRoom?.isFinalRound ?? ((snapshot.roundIndex ?? -1) + 1 >= snapshot.roundCount);
  const next = snapshot.phase === 'results_displayed' && isFinalRound
    ? { action: 'end' as const, label: 'Finish game', hint: 'Close the room with a final send-off' }
    : actionForPhase[snapshot.phase];
  const joinUrl = `${location.origin}/join/${session.code}`;
  return <main className="host-shell">
    <header className="host-header"><Brand compact /><div><span className="phase-badge">{phaseLabels[snapshot.phase]}</span><strong>Room {session.code}</strong></div></header>
    {(room.offline || room.error) && <div className="connection-banner">Connection interrupted — controls will resume when you’re back online.</div>}
    <div className="host-layout">
      <section className="host-overview">
        <div className="host-title"><div><p className="kicker">Control room</p><h1>{snapshot.phase === 'lobby' ? 'Ready when you are.' : `Round ${(snapshot.roundIndex ?? 0) + 1} of ${snapshot.roundCount}`}</h1></div><div className="room-code-block"><span>Room code</span><strong>{session.code}</strong></div></div>
        <div className="metric-grid">
          <article><span className="metric-icon">●</span><div><strong>{snapshot.connectedParticipantCount}</strong><span>Players joined</span></div></article>
          <article><span className="metric-icon">✓</span><div><strong>{snapshot.submittedAnswerCount}<i> / {snapshot.connectedParticipantCount}</i></strong><span>Answers in</span></div></article>
          <article><span className="metric-icon">#</span><div><strong>{snapshot.roundIndex === null ? '—' : snapshot.roundIndex + 1}<i> / {snapshot.roundCount}</i></strong><span>Current round</span></div></article>
        </div>
        <section className="round-panel">
          <div className="round-panel__head"><h2>Current round</h2><span>{phaseLabels[snapshot.phase]}</span></div>
          {snapshot.phase === 'lobby' ? <div className="empty-round"><span aria-hidden="true">✦</span><p>The first teammate is waiting in the wings.</p></div> : <div className="host-choice-grid">{snapshot.choices.map((choice, i) => <div key={choice.id} className={snapshot.revealedEmployee?.id === choice.id ? 'is-correct' : ''}><span>{choiceMarks[i]}</span><strong>{choice.displayName}</strong>{snapshot.revealedEmployee?.id === choice.id && <em>Correct</em>}</div>)}</div>}
          {hostRoom?.correctEmployee && <div className="host-reveal"><span>Correct answer</span><strong>{hostRoom.correctEmployee.displayName}</strong>{hostRoom.correctEmployee.team && <small>{hostRoom.correctEmployee.team}</small>}</div>}
        </section>
      </section>
      <aside className="host-actions">
        <div><p className="kicker">Next up</p>{next ? <><h2>{next.label}</h2><p>{next.hint}</p><button className="button button--primary button--block" disabled={Boolean(busy) || room.offline} onClick={() => { void act(next.action); }}>{busy ? 'Working…' : next.label} <span>→</span></button></> : <><h2>Game complete</h2><p>Every round has been played.</p></>}</div>
        {actionError && <Notice tone="error">{actionError}</Notice>}
        <div className="host-links"><p className="kicker">Share</p><a href={`/display/${session.code}`} target="_blank" rel="noreferrer">Open shared display <span>↗</span></a><button onClick={() => { void navigator.clipboard.writeText(joinUrl); }}>Copy join link <span>⧉</span></button></div>
      </aside>
    </div>
  </main>;
}

function Display({ code }: { code: string }) {
  const room = useRoomSnapshot(code);
  if (room.loading && !room.snapshot) return <main className="display-shell"><Spinner /></main>;
  if (!room.snapshot) return <main className="display-shell display-center"><h1>Room not found</h1><p>{room.error}</p></main>;
  const snapshot = room.snapshot;
  const reveal = snapshot.revealedEmployee;
  const joinUrl = `${location.origin}/join/${code}`;
  return <main className={`display-shell display-state-${snapshot.phase}`}>
    <header className="display-header"><Brand compact /><div><span className="live-dot">Live</span><strong>Round {(snapshot.roundIndex ?? 0) + 1} / {snapshot.roundCount}</strong></div></header>
    {room.offline && <div className="connection-banner">Display offline — reconnecting automatically</div>}
    {snapshot.phase === 'lobby' && <section className="display-lobby">
      <div className="display-lobby__copy"><p className="kicker">Gather your crew</p><h1>Who knows the team <em>best?</em></h1><p>Grab your phone, scan the code, and join the room.</p><div className="lobby-count"><span className="pulse-dot" /><strong>{snapshot.connectedParticipantCount}</strong> player{snapshot.connectedParticipantCount === 1 ? '' : 's'} ready</div></div>
      <div className="join-board"><div className="qr"><QRCodeSVG value={joinUrl} size={240} level="M" marginSize={2} title={`Scan to join room ${code}`} /></div><p>Join at <strong>{location.host}</strong></p><div className="giant-code">{code}</div></div>
    </section>}
    {snapshot.phase === 'question_open' && <section className="display-question"><MysteryPortrait large /><div className="display-question__copy"><p className="kicker">Round {(snapshot.roundIndex ?? 0) + 1}</p><h1>Who is this<br />team member?</h1><div className="display-choices">{snapshot.choices.map((choice, i) => <div key={choice.id}><span>{choiceMarks[i]}</span>{choice.displayName}</div>)}</div><div className="progress-line"><div><b style={{ width: `${snapshot.connectedParticipantCount ? (snapshot.submittedAnswerCount / snapshot.connectedParticipantCount) * 100 : 0}%` }} /></div><strong>{snapshot.submittedAnswerCount} / {snapshot.connectedParticipantCount}</strong><span>answers in</span></div></div></section>}
    {snapshot.phase === 'answers_locked' && <section className="display-center locked-screen"><div className="lock-icon">◆</div><p className="kicker">The room has spoken</p><h1>Answers locked.</h1><p>Let’s meet the teammate…</p></section>}
    {(snapshot.phase === 'employee_revealed' || snapshot.phase === 'results_displayed') && reveal && <section className="display-reveal">
      <div className="display-portrait">{reveal.mediaAvailable ? <img src={`/api/rooms/${code}/media/${reveal.id}`} alt={`Portrait of ${reveal.displayName}`} /> : <span>{reveal.displayName.slice(0, 1)}</span>}</div>
      <div className="display-reveal__copy"><p className="kicker">Say hello to</p><h1>{reveal.displayName}</h1>{reveal.team && <h2>{reveal.team}</h2>}{reveal.funFact && <blockquote>“{reveal.funFact}”</blockquote>}{snapshot.phase === 'results_displayed' && <Results snapshot={snapshot} large />}</div>
    </section>}
    {snapshot.phase === 'complete' && <section className="display-center complete-screen"><div className="celebration-mark">✦</div><p className="kicker">That’s a wrap</p><h1>Better teams start with<br />knowing each other.</h1><p>Thanks for playing.</p></section>}
    <footer className="display-footer"><span>Name That Team Member</span><span>Room {code}</span></footer>
  </main>;
}

function NotFound() { return <main className="error-page"><Brand /><h1>Nothing to see here.</h1><p>Check the link or head back to the game.</p><a className="button button--primary" href="/">Go home</a></main>; }

export function App() {
  const path = usePath();
  const join = path.match(/^\/join\/([A-Z2-9]{5})$/i);
  const play = path.match(/^\/play\/([A-Z2-9]{5})$/i);
  const display = path.match(/^\/display\/([A-Z2-9]{5})$/i);
  if (join?.[1]) return <Join code={join[1].toUpperCase()} />;
  if (play?.[1]) return <ParticipantRoute code={play[1].toUpperCase()} />;
  if (display?.[1]) return <Display code={display[1].toUpperCase()} />;
  if (path === '/host' || /^\/host\/[A-Z2-9]{5}$/i.test(path)) return <Host />;
  if (path === '/') return <Home />;
  return <NotFound />;
}
