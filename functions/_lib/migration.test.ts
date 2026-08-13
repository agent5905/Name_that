import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/202608110001_authoritative_game.sql', import.meta.url),
  'utf8',
);
const realtimePatch = readFileSync(
  new URL('../../supabase/migrations/202608110002_private_realtime_authorization.sql', import.meta.url),
  'utf8',
);
const lifecycle = readFileSync(new URL('../../supabase/migrations/202608110003_saved_games_and_repeatable_sessions.sql',import.meta.url),'utf8');
const hardening = readFileSync(new URL('../../supabase/migrations/202608110004_security_hardening.sql',import.meta.url),'utf8');
const mediaGc = readFileSync(new URL('../../supabase/migrations/202608110005_media_reservations_and_gc.sql',import.meta.url),'utf8');
const aggregateLimits = readFileSync(new URL('../../supabase/migrations/202608110006_aggregate_media_limits.sql',import.meta.url),'utf8');
const projectBudget = readFileSync(new URL('../../supabase/migrations/202608110007_project_daily_budget_and_cleanup.sql',import.meta.url),'utf8');
const churnHardening = readFileSync(new URL('../../supabase/migrations/202608110008_game_churn_and_atomic_budget.sql',import.meta.url),'utf8');
const atomicGameBudgets = readFileSync(new URL('../../supabase/migrations/202608110009_atomic_game_budgets.sql',import.meta.url),'utf8');
const explicitMedia = readFileSync(new URL('../../supabase/migrations/202608110010_explicit_mystery_reveal_media.sql',import.meta.url),'utf8');
const sessionCryptoSearchPath = readFileSync(new URL('../../supabase/migrations/202608110011_session_crypto_search_path.sql',import.meta.url),'utf8');
const priorityPhaseBroadcast = readFileSync(new URL('../../supabase/migrations/202608110012_priority_phase_broadcast.sql',import.meta.url),'utf8');
const authoritativePhasePush = readFileSync(new URL('../../supabase/migrations/202608110013_authoritative_phase_push.sql',import.meta.url),'utf8');
const directHostPhaseAction = readFileSync(new URL('../../supabase/migrations/202608110014_direct_host_phase_action.sql',import.meta.url),'utf8');
const capacity225 = readFileSync(new URL('../../supabase/migrations/202608110015_225_participant_capacity.sql',import.meta.url),'utf8');
const leaderboardPhase = readFileSync(new URL('../../supabase/migrations/202608110016_leaderboard_phase.sql',import.meta.url),'utf8');
const scoring = readFileSync(new URL('../../supabase/migrations/202608110017_authoritative_scoring.sql',import.meta.url),'utf8');
const scoringBroadcastFix = readFileSync(new URL('../../supabase/migrations/202608110018_scoring_broadcast_variable_fix.sql',import.meta.url),'utf8');
const legacyScoringAliasFix = readFileSync(new URL('../../supabase/migrations/202608110019_legacy_scoring_alias_fix.sql',import.meta.url),'utf8');
const applyScript=readFileSync(new URL('../../scripts/apply-supabase.mjs',import.meta.url),'utf8');

describe('authoritative migration regression guards', () => {
  it('commits the enum addition before the scoring migration references it',()=>{
    expect(leaderboardPhase).toContain("add value if not exists 'leaderboard_displayed'");
    expect(leaderboardPhase).not.toContain('create or replace function');
    expect(applyScript.indexOf("['202608110016'")).toBeGreaterThan(applyScript.indexOf("['202608110015'"));
    expect(applyScript.indexOf("['202608110017'")).toBeGreaterThan(applyScript.indexOf("['202608110016'"));
  });

  it('scores only from database clocks and preserves round-stable answer retries',()=>{
    const answer=scoring.slice(scoring.indexOf('function public.submit_answer('),scoring.indexOf('function public.participant_answer('));
    expect(answer).toContain('p_expected_round integer');
    expect(answer.indexOf('select choice_id into existing')).toBeLessThan(answer.indexOf("r.phase<>'question_open'"));
    expect(answer).toContain('r.current_round<>p_expected_round');
    expect(answer).toContain('accepted:=clock_timestamp()');
    expect(answer).toContain('authoritative_elapsed_ms,points_awarded,streak_before,streak_after');
    expect(answer).not.toContain('p_elapsed');
    expect(answer).not.toContain('p_score');
    expect(scoring).toContain('250::bigint * (20000 - least(greatest(p_elapsed_ms,0),20000)) + 10000');
    expect(legacyScoringAliasFix).toContain('from public.rounds legacy_round');
    expect(legacyScoringAliasFix).not.toContain('from public.rounds r\n');
    expect(applyScript).toContain("['202608110019', '../supabase/migrations/202608110019_legacy_scoring_alias_fix.sql']");
  });

  it('updates the score aggregate only after a unique immutable answer insert',()=>{
    const answer=scoring.slice(scoring.indexOf('function public.submit_answer('),scoring.indexOf('function public.participant_answer('));
    expect(answer.match(/on conflict\(question_id,player_id\)do nothing/g)).toHaveLength(1);
    expect(answer.match(/on conflict\(round_id,player_id\)do nothing/g)).toHaveLength(1);
    expect(answer.indexOf('if existing is null then raise exception')).toBeLessThan(answer.indexOf('update public.players set total_score'));
    expect(answer).toContain("'idempotent',true");
  });

  it('keeps personal outcomes private until reveal and materializes bounded deterministic boards',()=>{
    const personal=scoring.slice(scoring.indexOf('function public.participant_answer('),scoring.indexOf('function public.host_action('));
    expect(personal).toContain("r.phase in('question_open','answers_locked')");
    expect(personal).toContain('visible_score:=p.total_score-points');
    expect(personal).toContain("r.phase in('employee_revealed','results_displayed','leaderboard_displayed','complete')");
    expect(personal).toContain('p.eligible_from_round<=r.current_round');
    expect(personal).toContain("'roundIndex',r.current_round");
    expect(personal).toContain("'standing',standing");
    expect(scoring).toContain('total_score desc,p.correct_answer_count desc');
    expect(scoring).toContain("'correctAnswers',correct_answer_count");
    expect(scoring).toContain("r.current_round=last_round then 10 else 5");
  });

  it('requires a final leaderboard before completion and retains phase-only broadcasts',()=>{
    const host=scoring.slice(scoring.indexOf('function public.host_action('),scoring.indexOf('function public.host_action_direct('));
    expect(host).toContain("when'show_leaderboard'");
    expect(host).toContain("r.phase<>'leaderboard_displayed'or r.current_round<>last_round");
    expect(host).toContain("r.phase not in('results_displayed','leaderboard_displayed')");
    expect(scoring).toContain("p_action not in('start','lock','reveal','show_results','show_leaderboard','next_round','end')");
    expect(scoring).toContain("new.phase is not distinct from old.phase and new.round_index is not distinct from old.round_index then return null");
    expect(scoring).toContain("'leaderboard',new.leaderboard");
    expect(scoringBroadcastFix).toContain('where r.code=v_code');
    expect(scoringBroadcastFix).not.toContain('where r.code=code');
    expect(applyScript).toContain("['202608110018', '../supabase/migrations/202608110018_scoring_broadcast_variable_fix.sql']");
  });
  it('raises the effective serialized admission boundary to exactly 225 with retry-stable joins', () => {
    const join = capacity225.slice(capacity225.indexOf('function public.join_room('), capacity225.indexOf('function public.submit_answer('));
    expect(join).toContain('where code = p_code for update');
    expect(join).toContain('if v_count >= 225');
    expect(join).toContain('join_operation_id = p_join_operation_id');
    expect(join).toContain("message = 'IDEMPOTENCY_CONFLICT'");
    expect(capacity225).toContain('players_room_join_operation_idx');
    expect(applyScript).toContain("['202608110015', '../supabase/migrations/202608110015_225_participant_capacity.sql']");
  });

  it('admits concurrent answers exactly once behind a shared/exclusive phase gate', () => {
    const answer = capacity225.slice(capacity225.indexOf('function public.submit_answer('), capacity225.indexOf('function public.host_action('));
    const host = capacity225.slice(capacity225.indexOf('function public.host_action('), capacity225.indexOf('function public.broadcast_room_snapshot_invalidation('));
    expect(answer).toContain("pg_advisory_xact_lock_shared(hashtextextended('room-answer-gate:' || p_code, 0))");
    expect(answer.match(/on conflict \(question_id, player_id\) do nothing/g)).toHaveLength(1);
    expect(answer.match(/on conflict \(round_id, player_id\) do nothing/g)).toHaveLength(1);
    expect(answer).toContain("'idempotent', true");
    expect(answer).toContain("message = 'ANSWER_IMMUTABLE'");
    expect(host).toContain("pg_advisory_xact_lock(hashtextextended('room-answer-gate:' || p_code, 0))");
    expect(host.indexOf('pg_advisory_xact_lock(')).toBeLessThan(host.indexOf('where code = p_code for update'));
  });

  it('updates progress without snapshot recomputation or same-phase Realtime fan-out', () => {
    expect(capacity225).toContain('submitted_answer_count = s.submitted_answer_count + 1');
    expect(capacity225).toContain('connected_participant_count = s.connected_participant_count + 1');
    expect(capacity225).toContain("if tg_op = 'UPDATE'");
    expect(capacity225).toContain('new.phase is not distinct from old.phase');
    expect(capacity225).toContain('new.round_index is not distinct from old.round_index');
    const broadcaster = capacity225.slice(capacity225.indexOf('function public.broadcast_room_snapshot_invalidation('));
    expect(broadcaster.indexOf('return null;')).toBeLessThan(broadcaster.indexOf('perform realtime.send('));
    const answer = capacity225.slice(capacity225.indexOf('function public.submit_answer('), capacity225.indexOf('function public.host_action('));
    expect(answer).not.toContain('refresh_room_snapshot');
    expect(answer).not.toContain('update public.rooms');
  });
  it('exposes only the credential-checked host state machine for direct low-latency phase cues', () => {
    expect(directHostPhaseAction).toContain('security definer');
    expect(directHostPhaseAction).toContain("set search_path = ''");
    expect(directHostPhaseAction).toContain('p_code is null or p_host_token is null or p_action is null');
    expect(directHostPhaseAction).toContain("p_host_token !~ '^[A-Za-z0-9_-]{43}$'");
    expect(directHostPhaseAction).toContain("p_action not in ('start','lock','reveal','show_results','next_round','end')");
    expect(directHostPhaseAction).toContain("v_supplied := extensions.digest(p_host_token, 'sha256')");
    expect(directHostPhaseAction).toContain('v_expected is distinct from v_supplied');
    expect(directHostPhaseAction).toContain("return public.host_action(p_code, pg_catalog.encode(v_supplied, 'hex'), p_action)");
    expect(directHostPhaseAction).toContain('revoke all on function public.host_action_direct(text,text,text) from public');
    expect(directHostPhaseAction).toContain('grant execute on function public.host_action_direct(text,text,text) to anon, authenticated');
    expect(applyScript).toContain("['202608110014', '../supabase/migrations/202608110014_direct_host_phase_action.sql']");
  });
  it('computes totals independently and emits one aggregate row per choice', () => {
    expect(migration).toContain("'totalAnswers', (select count(*) from public.answers a where a.round_id = v_round.id)");
    expect(migration).toContain("from public.round_choices c\n      where c.round_id = v_round.id;");
    expect(migration).not.toContain('from public.round_choices c left join public.answers');
  });

  it('requires four members and always seeds the correct member into its four choices', () => {
    expect(migration).toContain('if v_active_count < 4 then');
    expect(migration).toContain('select v_employee.id::uuid as employee_id');
    expect(migration).toContain('e.id <> v_employee.id');
    expect(migration).toContain('limit 3');
  });

  it('uses database CSPRNG bytes for both correct sequence and choice layout', () => {
    expect(migration).toContain('where active order by gen_random_bytes(16)');
    expect(migration.match(/gen_random_bytes\(16\)/g)).toHaveLength(3);
    expect(migration).not.toContain('order by slug loop');
    expect(migration).not.toContain('order by md5');
  });

  it('preserves the original locked boundary before the additive 225-player capacity patch', () => {
    const lock = migration.indexOf('where code = p_code for update', migration.indexOf('function public.join_room'));
    const count = migration.indexOf('select count(*) into v_player_count', lock);
    const cap = migration.indexOf('if v_player_count >= 100', count);
    const insert = migration.indexOf('insert into public.players', cap);
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(cap);
    expect(cap).toBeLessThan(insert);
  });

  it('uses private receive-only code-scoped Broadcast with no snapshot publication or read grant', () => {
    expect(migration).toContain("'room_snapshot_changed'");
    expect(migration).toContain('v_code text := coalesce(new.room_code, old.room_code)');
    expect(migration).toContain("'room:' || v_code");
    expect(migration).toContain("jsonb_build_object('roomCode', v_code, 'version', v_version)");
    expect(migration).toContain('after insert or update or delete on public.room_snapshots');
    expect(migration).toContain('create policy room_snapshot_broadcast_receive on realtime.messages');
    expect(migration).toContain("realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(migration).toContain('create policy room_snapshot_broadcast_client_send_deny on realtime.messages\n  as restrictive for insert to anon, authenticated');
    expect(migration).toContain("realtime.topic() !~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(migration).toMatch(/'room:' \|\| v_code,\s+true\s+\)/);
    expect(migration).not.toContain('alter publication supabase_realtime add table public.room_snapshots');
    expect(migration).not.toContain('grant select on public.room_snapshots to anon');
    expect(migration).not.toContain("'room:' || v_code,\n    false");
  });

  it('ships an idempotent hosted patch for private Realtime authorization', () => {
    expect(realtimePatch).toContain('drop policy if exists room_snapshot_broadcast_receive on realtime.messages');
    expect(realtimePatch).toContain('drop policy if exists room_snapshot_broadcast_client_send_deny on realtime.messages');
    expect(realtimePatch).toContain('drop trigger if exists room_snapshot_broadcast on public.room_snapshots');
    expect(realtimePatch).toContain("realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(realtimePatch).toMatch(/'room:' \|\| v_code,\s+true\s+\)/);
    expect(realtimePatch).toContain('create or replace function public.cleanup_stale_realtime_auth_users()');
    expect(realtimePatch).toContain("raw_user_meta_data ->> 'application' = 'name-that-realtime'");
    expect(realtimePatch).toContain("created_at < now() - interval '30 days'");
  });

  it('hardens future defaults and makes the reveal-media client deny restrictive', () => {
    expect(migration).toContain('alter default privileges in schema public revoke all on tables from public, anon, authenticated');
    expect(migration).toContain('alter default privileges in schema public revoke execute on functions from public, anon, authenticated');
    expect(migration).toContain('create policy reveal_media_never_client_select on storage.objects\n  as restrictive for select to anon, authenticated');
  });

  it('atomically persists a hashed-source five-per-fifteen-minute creation gate', () => {
    expect(migration).toContain('create table public.room_creation_limits');
    expect(migration).toContain('source_hash bytea primary key check (octet_length(source_hash) = 32)');
    expect(migration).toContain("v_limit constant integer := 5");
    expect(migration).toContain("v_window constant interval := interval '15 minutes'");
    expect(migration).toContain("where source_hash = decode(p_source_hash, 'hex') for update");
    expect(migration).toContain("'retryAfterSeconds', v_retry_after");
    expect(migration).toContain('grant execute on function public.consume_room_creation_attempt(text), public.cleanup_expired_rooms()\n  to service_role');
  });

  it('expires only completed or inactive rooms under row locks with scoped cascading cleanup', () => {
    expect(migration).toContain("phase = 'complete' and updated_at < now() - interval '12 hours'");
    expect(migration).toContain("updated_at < now() - interval '24 hours'");
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain('delete from public.room_snapshots where room_code = any(v_room_codes)');
    expect(migration).toContain('delete from public.rooms where id = any(v_room_ids)');
  });

  it('cannot end a room before results have already been disclosed', () => {
    expect(migration).toContain("if v_room.phase <> 'results_displayed' then raise exception");
  });

  it('exposes current-round identity only through the host-authenticated RPC', () => {
    expect(migration).toContain("'correctEmployee', v_correct_employee");
    expect(migration).toContain("'isFinalRound', v_room.current_round is not null and v_room.current_round = v_round_count - 1");
    expect(migration).toContain('if v_room.host_token_hash <> decode(p_host_token_hash');
  });
});

describe('saved-game lifecycle migration guards',()=>{
  it('provides the composite choice key required by session answer integrity',()=>{
    expect(lifecycle).toContain('unique (question_id, id)');
    expect(lifecycle).toContain('foreign key (question_id, choice_id) references public.session_choices(question_id, id)');
  });
  it('recovers an idempotent created session even after its saved game is soft deleted',()=>{
    const create=lifecycle.slice(lifecycle.indexOf('function public.create_game_session'),lifecycle.indexOf('function public.play_again_session'));
    expect(create.indexOf('select * into v_existing')).toBeLessThan(create.indexOf('deleted_at is null for share'));
    expect(create).toContain('select 1 from public.games where id=p_game_id and owner_id=v_owner');
  });
  it('copies both original and silhouette MIME types into each session snapshot',()=>{
    expect(lifecycle).toContain('m.mime_type, m.silhouette_mime_type from public.game_questions');
    expect(lifecycle).toContain('v_q.mime_type,v_q.silhouette_mime_type');
  });
  it('bounds saved-game, media, and live-session resource growth',()=>{
    expect(lifecycle).toContain('create table public.saved_session_creation_limits');
    expect(lifecycle).toContain('v_limit constant integer := 20');
    expect(lifecycle).toContain("message='GAME_QUOTA_EXCEEDED'");
    expect(lifecycle).toContain("message='MEDIA_QUOTA_EXCEEDED'");
    expect(lifecycle).toContain("message='SESSION_QUOTA_EXCEEDED'");
    expect(lifecycle).toContain("r.phase<>'complete')>=10");
    expect(lifecycle).toContain("r.updated_at>now()-interval '24 hours')>=50");
  });
  it('allows media registration only on a live game owned by the credential',()=>{
    const register=lifecycle.slice(lifecycle.indexOf('function public.register_game_media'),lifecycle.indexOf('function public.get_game_media'));
    expect(register).toContain('owner_id = v_owner and deleted_at is null');
  });
  it('is additive and snapshots definition content independently of saved games',()=>{
    expect(lifecycle).toContain('create table public.session_questions');
    expect(lifecycle).toContain('create table public.session_choices');
    expect(lifecycle).toContain("content_mode text not null default 'legacy'");
    expect(lifecycle).toContain("values (p_code, decode(p_host_token_hash,'hex'), p_game_id, v_game.revision, v_game.name, p_idempotency_key, 'saved')");
  });
  it('supports every late-join state but rejects completed rooms distinctly under the room lock',()=>{
    const join=lifecycle.slice(lifecycle.indexOf('function public.join_room'),lifecycle.indexOf('function public.submit_answer'));
    expect(join.indexOf('where code=p_code for update')).toBeLessThan(join.indexOf("v_room.phase='complete'"));
    expect(join).toContain("message='GAME_ENDED'");
    expect(join).toContain("when v_room.phase='question_open' then v_room.current_round else v_room.current_round+1");
  });
  it('drives saved sessions through their session question count and only ends on final results',()=>{
    expect(lifecycle).toContain("if v_room.content_mode='saved' then select max(position) into v_last");
    expect(lifecycle).toContain("v_room.phase<>'results_displayed' or v_room.current_round<>v_last");
  });
  it('uses ordered recorded migration application without falsely marking patch 002',()=>{
    expect(applyScript.indexOf("['202608110001'")).toBeLessThan(applyScript.indexOf("['202608110002'"));
    expect(applyScript.indexOf("['202608110002'")).toBeLessThan(applyScript.indexOf("['202608110003'"));
    expect(applyScript.indexOf("['202608110003'")).toBeLessThan(applyScript.indexOf("['202608110004'"));
    expect(applyScript.indexOf("['202608110004'")).toBeLessThan(applyScript.indexOf("['202608110005'"));
    expect(applyScript.indexOf("['202608110005'")).toBeLessThan(applyScript.indexOf("['202608110006'"));
    expect(applyScript.indexOf("['202608110006'")).toBeLessThan(applyScript.indexOf("['202608110007'"));
    expect(applyScript.indexOf("['202608110007'")).toBeLessThan(applyScript.indexOf("['202608110008'"));
    expect(applyScript.indexOf("['202608110008'")).toBeLessThan(applyScript.indexOf("['202608110009'"));
    expect(applyScript.indexOf("['202608110009'")).toBeLessThan(applyScript.indexOf("['202608110010'"));
    expect(applyScript.indexOf("['202608110010'")).toBeLessThan(applyScript.indexOf("['202608110011'"));
    expect(applyScript.indexOf("['202608110011'")).toBeLessThan(applyScript.indexOf("['202608110012'"));
    expect(applyScript.indexOf("['202608110012'")).toBeLessThan(applyScript.indexOf("['202608110013'"));
    expect(applyScript).toContain("values('202608110001') on conflict");
    expect(applyScript).not.toContain("values('202608110001'),('202608110002')");
  });
  it('labels trusted realtime invalidations with the authoritative phase',()=>{
    expect(priorityPhaseBroadcast).toContain("'phase', v_phase");
    expect(priorityPhaseBroadcast).toContain("'room_snapshot_changed'");
    expect(priorityPhaseBroadcast).toMatch(/'room:' \|\| v_code,\s+true\s+\)/);
    expect(priorityPhaseBroadcast).toContain('revoke all on function public.broadcast_room_snapshot_invalidation()');
  });
  it('pushes only the sanitized room projection and phase-gated per-session reveal material',()=>{
    expect(authoritativePhasePush).toContain("'snapshot',v_snapshot");
    expect(authoritativePhasePush).toContain("new.phase is distinct from old.phase");
    expect(authoritativePhasePush).toContain("new.phase in ('employee_revealed','results_displayed','complete')");
    expect(authoritativePhasePush).toContain("r.content_mode='saved'");
    expect(authoritativePhasePush).toContain("'revealKey',v_key");
    expect(authoritativePhasePush).not.toContain('storage_path');
    expect(authoritativePhasePush).toMatch(/'room:'\|\|v_code,true/);
    expect(authoritativePhasePush).toContain('revoke all on function public.broadcast_room_snapshot_invalidation()');
  });
  it('stores explicit image pairs and immutable fun facts without generating a mystery image',()=>{
    expect(explicitMedia).toContain('mystery_media_asset_id uuid');expect(explicitMedia).toContain('reveal_media_asset_id uuid');expect(explicitMedia).toContain('add column fun_fact text');
    expect(explicitMedia).toContain('mystery_media_path,reveal_media_path');expect(explicitMedia).toContain('q.fun_fact');expect(explicitMedia).not.toContain('generateSilhouette');
  });
  it('snapshots an encrypted reveal once and releases only the correct current key after reveal',()=>{
    expect(explicitMedia).toContain('extensions.gen_random_bytes(32)');expect(explicitMedia).toContain('extensions.gen_random_bytes(12)');expect(explicitMedia).toContain("p_kind not in('mystery','reveal')");
    expect(explicitMedia).toContain("r.phase not in('employee_revealed','results_displayed','complete')");expect(explicitMedia).toContain('correct is distinct from p_choice_id');
    expect(explicitMedia).toContain("'kind','reveal-encrypted'");expect(explicitMedia).toContain("'&asset='||q.id");expect(explicitMedia).toContain('id=p_asset_id');
  });
  it('ships a forward repair for pgcrypto search paths and incomplete saved-session keys',()=>{
    expect(sessionCryptoSearchPath.match(/create or replace function public\.(create_game_session|play_again_session)/g)).toHaveLength(2);
    expect(sessionCryptoSearchPath.match(/extensions\.gen_random_bytes\(32\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sessionCryptoSearchPath.match(/extensions\.gen_random_bytes\(12\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sessionCryptoSearchPath).not.toMatch(/(?<!extensions\.)gen_random_bytes\(/);
    expect(sessionCryptoSearchPath).toContain("r.content_mode='saved'");
    expect(sessionCryptoSearchPath).toContain("reveal_aad='name-that:'||q.room_id||':'||q.id");
    expect(sessionCryptoSearchPath).toContain("m.id=coalesce(x.mystery_media_asset_id,x.media_asset_id)");
    expect(sessionCryptoSearchPath).toContain('revoke all on function public.create_game_session');
    expect(sessionCryptoSearchPath).toContain('to service_role');
  });
  it('keeps legacy saved media hostable while omitting unavailable encrypted preload',()=>{
    expect(explicitMedia).toContain('coalesce(mystery_storage_path,silhouette_storage_path)');expect(explicitMedia).toContain('coalesce(reveal_storage_path,storage_path)');
    expect(explicitMedia).toContain('coalesce(mystery_storage_path,silhouette_storage_path)');
  });
  it('charges source bytes inside the pair registration transaction after hard quotas',()=>{
    const register=explicitMedia.slice(explicitMedia.indexOf('function public.register_game_media_pair'),explicitMedia.indexOf('function public.complete_game_media_pair'));
    expect(register.indexOf('PROJECT_MEDIA_CAPACITY_REACHED')).toBeLessThan(register.indexOf('reserve_media_source_bytes'));
    expect(register.indexOf('reserve_media_source_bytes')).toBeLessThan(register.indexOf('reserve_project_media_bytes'));
    expect(register).toContain('p_source_hash text');
  });
  it('copies every explicit media/key/fact field on create and replay and accounts all bytes',()=>{
    expect(explicitMedia).toContain('total:=p_mystery_bytes+p_reveal_bytes');expect(explicitMedia.match(/mystery_media_path,reveal_media_path,mystery_media_mime_type,reveal_media_mime_type,reveal_key,reveal_iv,reveal_aad,fun_fact/g)?.length).toBeGreaterThanOrEqual(2);
    expect(explicitMedia).toContain('q.question_id');expect(explicitMedia).not.toContain('select x.*,m.*');
  });
  it('widens both atomic byte reservations only to the maximum canonical pair plus GCM tag',()=>{
    expect(explicitMedia.match(/p_byte_size not between 1 and 10485760/g)).toHaveLength(2);
    expect(explicitMedia).toContain("pg_advisory_xact_lock(hashtextextended('game-media-project-daily-budget',0))");
    expect(explicitMedia).toContain('reserved_bytes=reserved_bytes+p_byte_size');
  });
  it('keeps garbage collection scoped to the two stored source images',()=>{
    expect(explicitMedia).not.toContain('encrypted_reveal_storage_path');expect(explicitMedia).toContain('q.media_path=m.storage_path');
  });
  it('authenticates and bounds image processing while recovering quota after stale saves',()=>{
    expect(hardening).toContain('create table public.media_upload_limits');
    expect(hardening).toContain('v_limit constant integer := 100');
    expect(hardening).toContain('v_owner := public.admin_owner_id(p_admin_token_hash)');
    expect(hardening).toContain("m.created_at>now()-interval '24 hours'");
    expect(hardening).toContain('exists(select 1 from public.game_questions q where q.media_asset_id=m.id)');
    expect(hardening).toContain('from public, anon, authenticated');
  });
  it('reserves every object before upload and only reclaims definition-and-session orphans',()=>{
    expect(mediaGc).toContain("values(v_owner,p_game_id,p_storage_path,p_silhouette_storage_path,p_mime_type,p_silhouette_mime_type,p_byte_size,'pending')");
    expect(mediaGc).toContain("set upload_state='ready'");
    expect(mediaGc).toContain("m.upload_state='pending' and m.created_at<now()-interval '1 hour'");
    expect(mediaGc).toContain('where sq.media_path=m.storage_path or sq.silhouette_media_path=m.silhouette_storage_path');
    expect(mediaGc).toContain("active.deleted_at is null");
    expect(mediaGc).toContain('delete from public.game_questions where game_id=p_game_id');
    expect(mediaGc).toContain('p_media_ids uuid[]');
  });
  it('prevents owner rotation from multiplying source and project media allowances',()=>{
    expect(aggregateLimits).toContain('create table public.admin_profile_creation_limits');
    expect(aggregateLimits).toContain('create table public.media_source_upload_limits');
    expect(aggregateLimits).toContain('create table public.media_source_byte_limits');
    expect(aggregateLimits).toContain('v_limit constant integer:=30');
    expect(aggregateLimits).toContain('v_limit constant bigint:=262144000');
    expect(aggregateLimits).toContain("pg_advisory_xact_lock(hashtextextended('game-media-project-quota',0))");
    expect(aggregateLimits).toContain('sum(byte_size+65536::bigint)');
    expect(aggregateLimits).toContain('>=10000');
    expect(aggregateLimits).toContain('>5368709120');
  });
  it('bounds cross-source daily growth, reserves headroom, and prunes stale identities and counters',()=>{
    expect(projectBudget).toContain('create table public.project_media_daily_budget');
    expect(projectBudget).toContain('v_limit constant bigint:=536870912');
    expect(projectBudget).toContain("pg_advisory_xact_lock(hashtextextended('game-media-project-daily-budget',0))");
    expect(projectBudget).toContain('>4294967296');
    expect(projectBudget).toContain('>=8000');
    expect(projectBudget).toContain("window_started_at<now()-interval '3 days'");
    expect(projectBudget).toContain("last_seen_at<now()-interval '30 days'");
    expect(projectBudget).toContain('not exists(select 1 from public.games g where g.owner_id=a.id)');
    expect(projectBudget).toContain('not exists(select 1 from public.game_media_assets m where m.owner_id=a.id)');
  });
  it('bounds draft churn, purges only unreferenced deleted games, and charges media atomically',()=>{
    expect(churnHardening).toContain('create table public.game_mutation_limits');
    expect(churnHardening).toContain('v_limit constant integer:=200');
    expect(churnHardening).toContain("pg_advisory_xact_lock(hashtextextended('saved-game-project-quota',0))");
    expect(churnHardening).toContain("count(*) from public.games)>=10000");
    expect(churnHardening).toContain("count(*) from public.games where owner_id=v_owner)>=200");
    expect(churnHardening).toContain("g.deleted_at<now()-interval '1 day'");
    expect(churnHardening).toContain('not exists(select 1 from public.rooms r where r.game_id=g.id)');
    const register=churnHardening.slice(churnHardening.indexOf('function public.register_game_media'),churnHardening.indexOf('function public.cleanup_stale_studio_state'));
    expect(register.indexOf('MEDIA_QUOTA_EXCEEDED')).toBeLessThan(register.indexOf('reserve_project_media_bytes'));
    expect(register.indexOf('reserve_project_media_bytes')).toBeLessThan(register.indexOf('insert into public.game_media_assets'));
  });
  it('charges source and project game budgets inside successful mutation transactions',()=>{
    expect(atomicGameBudgets).toContain('create table public.game_source_daily_budgets');
    expect(atomicGameBudgets).toContain('create table public.game_project_daily_budget');
    expect(atomicGameBudgets).toContain('v_source_limit constant integer:=100');
    expect(atomicGameBudgets).toContain('v_project_limit constant integer:=1000');
    expect(atomicGameBudgets).toContain("pg_advisory_xact_lock(hashtextextended('saved-game-daily-project-budget',0))");
    expect(atomicGameBudgets).toContain('perform public.admit_game_mutation(p_source_hash)');
    expect(atomicGameBudgets).toContain("count(*)from public.games)>=8000");
    expect(atomicGameBudgets).toContain("delete from public.game_source_daily_budgets where window_started_at<now()-interval '2 days'");
  });
});
