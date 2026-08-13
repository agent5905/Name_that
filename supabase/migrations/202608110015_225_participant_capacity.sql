-- Capacity patch: admit exactly 225 participants while keeping room phase
-- transitions authoritative. Join/answer progress updates the materialized
-- aggregate for HTTP recovery, but only a phase/round transition is fanned out
-- over the private, receive-only Realtime channel.

create index if not exists session_answers_question_choice_idx
  on public.session_answers(question_id, choice_id);
create index if not exists answers_round_employee_idx
  on public.answers(round_id, employee_id);

alter table public.players
  add column if not exists join_operation_id uuid;
create unique index if not exists players_room_join_operation_idx
  on public.players(room_id, join_operation_id)
  where join_operation_id is not null;

-- Snapshot versions are the browser-facing ordering clock. Progress writes do
-- not need to contend on the rooms row, so keep this clock monotonic at the
-- materialized projection instead of incrementing rooms for every answer.
create or replace function public.advance_room_snapshot_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.version <= old.version then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.advance_room_snapshot_version() from public, anon, authenticated;
drop trigger if exists room_snapshot_advance_version on public.room_snapshots;
create trigger room_snapshot_advance_version
before update on public.room_snapshots
for each row execute function public.advance_room_snapshot_version();

-- The original decorator queried room/question/media rows on every snapshot
-- UPDATE. Count-only progress writes preserve their already-decorated fields;
-- only an insert or phase/round transition needs to rebuild descriptors.
create or replace function public.decorate_explicit_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.rooms%rowtype;
  q public.session_questions%rowtype;
  base integer;
  last integer;
  items jsonb := '[]'::jsonb;
begin
  if tg_op = 'UPDATE'
     and new.phase is not distinct from old.phase
     and new.round_index is not distinct from old.round_index then
    return new;
  end if;
  select * into r from public.rooms where code = new.room_code;
  if r.content_mode <> 'saved' then return new; end if;
  base := coalesce(r.current_round, 0);
  select max(position) into last from public.session_questions where room_id = r.id;
  select * into q from public.session_questions where room_id = r.id and position = base;
  if found then
    new.mystery_image_url := '/api/rooms/' || r.code || '/mystery';
    new.silhouette_url := new.mystery_image_url;
    items := items || jsonb_build_array(jsonb_build_object(
      'key', r.code || ':' || base || ':mystery',
      'kind', 'mystery',
      'roundIndex', base,
      'url', '/api/rooms/' || r.code || '/mystery-preload?round=' || base || '&asset=' || q.id
    ));
    if q.reveal_media_path is not null and q.reveal_key is not null
       and q.reveal_iv is not null and q.reveal_aad is not null then
      items := items || jsonb_build_array(jsonb_build_object(
        'key', r.code || ':' || base || ':reveal',
        'kind', 'reveal-encrypted',
        'roundIndex', base,
        'url', '/api/rooms/' || r.code || '/reveal-preload?round=' || base || '&asset=' || q.id
      ));
    end if;
    if new.revealed_employee is not null then
      if q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null then
        new.revealed_employee := jsonb_set(
          new.revealed_employee, '{mediaKey}', to_jsonb(r.code || ':' || base || ':reveal')
        );
      end if;
      if q.fun_fact is not null then
        new.revealed_employee := jsonb_set(new.revealed_employee, '{funFact}', to_jsonb(q.fun_fact));
      end if;
    end if;
  end if;
  if base < last then
    select * into q from public.session_questions where room_id = r.id and position = base + 1;
    items := items || jsonb_build_array(jsonb_build_object(
      'key', r.code || ':' || (base + 1) || ':mystery',
      'kind', 'mystery',
      'roundIndex', base + 1,
      'url', '/api/rooms/' || r.code || '/mystery-preload?round=' || (base + 1) || '&asset=' || q.id
    ));
    if q.reveal_media_path is not null and q.reveal_key is not null
       and q.reveal_iv is not null and q.reveal_aad is not null then
      items := items || jsonb_build_array(jsonb_build_object(
        'key', r.code || ':' || (base + 1) || ':reveal',
        'kind', 'reveal-encrypted',
        'roundIndex', base + 1,
        'url', '/api/rooms/' || r.code || '/reveal-preload?round=' || (base + 1) || '&asset=' || q.id
      ));
    end if;
  end if;
  new.preload_assets := items;
  return new;
end;
$$;

revoke all on function public.decorate_explicit_snapshot() from public, anon, authenticated;

create or replace function public.update_join_snapshot_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.room_snapshots s
  set connected_participant_count = s.connected_participant_count + 1,
      eligible_participant_count = s.eligible_participant_count +
        case when r.current_round is null or new.eligible_from_round <= r.current_round then 1 else 0 end,
      updated_at = clock_timestamp()
  from public.rooms r
  where r.id = new.room_id and s.room_code = r.code;
  return null;
end;
$$;

revoke all on function public.update_join_snapshot_progress() from public, anon, authenticated;
drop trigger if exists player_join_snapshot_progress on public.players;
create trigger player_join_snapshot_progress
after insert on public.players
for each row execute function public.update_join_snapshot_progress();

create or replace function public.update_answer_snapshot_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.room_snapshots s
  set submitted_answer_count = s.submitted_answer_count + 1,
      updated_at = clock_timestamp()
  from public.rooms r
  where r.id = new.room_id and s.room_code = r.code;
  return null;
end;
$$;

revoke all on function public.update_answer_snapshot_progress() from public, anon, authenticated;
drop trigger if exists session_answer_snapshot_progress on public.session_answers;
create trigger session_answer_snapshot_progress
after insert on public.session_answers
for each row execute function public.update_answer_snapshot_progress();
drop trigger if exists legacy_answer_snapshot_progress on public.answers;
create trigger legacy_answer_snapshot_progress
after insert on public.answers
for each row execute function public.update_answer_snapshot_progress();

create or replace function public.join_room(
  p_code text,
  p_display_name text,
  p_participant_token_hash text,
  p_join_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_player uuid;
  v_count integer;
  v_eligible integer;
  v_existing public.players%rowtype;
begin
  -- The room lock makes count-and-insert one exact admission boundary under a
  -- join burst. Host transitions use the same lock, preserving late-join rules.
  select * into v_room from public.rooms where code = p_code for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if btrim(p_display_name) = '' or char_length(btrim(p_display_name)) > 40
     or p_participant_token_hash !~ '^[0-9a-f]{64}$' or p_join_operation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  select * into v_existing from public.players
    where room_id = v_room.id and join_operation_id = p_join_operation_id;
  if found then
    if v_existing.display_name <> btrim(p_display_name)
       or v_existing.participant_token_hash <> decode(p_participant_token_hash, 'hex') then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'playerId', v_existing.id,
      'roomId', v_room.id,
      'displayName', v_existing.display_name,
      'eligibleFromRound', v_existing.eligible_from_round
    );
  end if;
  if v_room.phase = 'complete' then raise exception using errcode = 'P0001', message = 'GAME_ENDED'; end if;
  select count(*) into v_count from public.players where room_id = v_room.id;
  if v_count >= 225 then raise exception using errcode = 'P0001', message = 'ROOM_FULL'; end if;
  v_eligible := case
    when v_room.phase = 'lobby' then 0
    when v_room.phase = 'question_open' then v_room.current_round
    else v_room.current_round + 1
  end;
  insert into public.players(room_id, display_name, participant_token_hash, eligible_from_round, join_operation_id)
    values(v_room.id, btrim(p_display_name), decode(p_participant_token_hash, 'hex'), v_eligible, p_join_operation_id)
    returning id into v_player;
  return jsonb_build_object(
    'playerId', v_player,
    'roomId', v_room.id,
    'displayName', btrim(p_display_name),
    'eligibleFromRound', v_eligible
  );
end;
$$;

-- Service-only compatibility for operational scripts predating retry-stable
-- browser join operations. Production HTTP joins always call the four-argument
-- function above.
create or replace function public.join_room(p_code text, p_display_name text, p_participant_token_hash text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.join_room(p_code, p_display_name, p_participant_token_hash, gen_random_uuid());
$$;

create or replace function public.submit_answer(
  p_code text,
  p_player_id uuid,
  p_participant_token_hash text,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_round uuid;
  v_existing uuid;
  v_eligible integer;
begin
  -- Concurrent answers share this transaction-scoped gate. Host transitions
  -- take the exclusive form, so lock/reveal cannot cross an accepted insert.
  perform pg_advisory_xact_lock_shared(hashtextextended('room-answer-gate:' || p_code, 0));
  select * into v_room from public.rooms where code = p_code;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  select eligible_from_round into v_eligible
    from public.players
    where id = p_player_id and room_id = v_room.id
      and participant_token_hash = decode(p_participant_token_hash, 'hex');
  if not found then raise exception using errcode = '42501', message = 'PARTICIPANT_UNAUTHORIZED'; end if;
  if v_room.phase <> 'question_open' or v_eligible > v_room.current_round then
    raise exception using errcode = 'P0001', message = 'ANSWERS_CLOSED';
  end if;

  if v_room.content_mode = 'saved' then
    select id into strict v_round
      from public.session_questions
      where room_id = v_room.id and position = v_room.current_round;
    if not exists (
      select 1 from public.session_choices where question_id = v_round and id = p_employee_id
    ) then
      raise exception using errcode = '22023', message = 'INVALID_CHOICE';
    end if;
    insert into public.session_answers(room_id, question_id, player_id, choice_id)
      values(v_room.id, v_round, p_player_id, p_employee_id)
      on conflict (question_id, player_id) do nothing
      returning choice_id into v_existing;
    if found then
      return jsonb_build_object('accepted', true, 'idempotent', false, 'employeeId', v_existing);
    end if;
    select choice_id into strict v_existing
      from public.session_answers where question_id = v_round and player_id = p_player_id;
    if v_existing <> p_employee_id then raise exception using errcode = 'P0001', message = 'ANSWER_IMMUTABLE'; end if;
    return jsonb_build_object('accepted', true, 'idempotent', true, 'employeeId', v_existing);
  else
    select id into strict v_round
      from public.rounds where room_id = v_room.id and round_number = v_room.current_round;
    if not exists (
      select 1 from public.round_choices where round_id = v_round and employee_id = p_employee_id
    ) then
      raise exception using errcode = '22023', message = 'INVALID_CHOICE';
    end if;
    insert into public.answers(room_id, round_id, player_id, employee_id)
      values(v_room.id, v_round, p_player_id, p_employee_id)
      on conflict (round_id, player_id) do nothing
      returning employee_id into v_existing;
    if found then
      return jsonb_build_object('accepted', true, 'idempotent', false, 'employeeId', v_existing);
    end if;
    select employee_id into strict v_existing
      from public.answers where round_id = v_round and player_id = p_player_id;
    if v_existing <> p_employee_id then raise exception using errcode = 'P0001', message = 'ANSWER_IMMUTABLE'; end if;
    return jsonb_build_object('accepted', true, 'idempotent', true, 'employeeId', v_existing);
  end if;
end;
$$;

create or replace function public.host_action(p_code text, p_host_token_hash text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_last integer;
begin
  -- Always acquire the answer gate before the rooms row. Answer submissions
  -- never take the rooms row, while joins take only that row, so this ordering
  -- cannot form a lock cycle.
  perform pg_advisory_xact_lock(hashtextextended('room-answer-gate:' || p_code, 0));
  select * into v_room from public.rooms where code = p_code for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.host_token_hash <> decode(p_host_token_hash, 'hex') then
    raise exception using errcode = '42501', message = 'HOST_UNAUTHORIZED';
  end if;
  if v_room.content_mode = 'saved' then
    select max(position) into v_last from public.session_questions where room_id = v_room.id;
  else
    select max(round_number) into v_last from public.rounds where room_id = v_room.id;
  end if;
  case p_action
    when 'start' then
      if v_room.phase <> 'lobby' or v_last is null then raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'question_open'; v_room.current_round := 0;
    when 'lock' then
      if v_room.phase <> 'question_open' then raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'answers_locked';
    when 'reveal' then
      if v_room.phase <> 'answers_locked' then raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'employee_revealed';
    when 'show_results' then
      if v_room.phase <> 'employee_revealed' then raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'results_displayed';
    when 'next_round' then
      if v_room.phase <> 'results_displayed' or v_room.current_round >= v_last then
        raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION';
      end if;
      v_room.phase := 'question_open'; v_room.current_round := v_room.current_round + 1;
    when 'end' then
      if v_room.phase <> 'results_displayed' or v_room.current_round <> v_last then
        raise exception using errcode = 'P0001', message = 'ILLEGAL_TRANSITION';
      end if;
      v_room.phase := 'complete';
    else
      raise exception using errcode = '22023', message = 'INVALID_ACTION';
  end case;
  update public.rooms
    set phase = v_room.phase,
        current_round = v_room.current_round,
        version = version + 1,
        updated_at = now()
    where id = v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return (select to_jsonb(s) from public.room_snapshots s where room_code = p_code);
end;
$$;

-- Suppress join/answer fan-out. A transition refresh changes phase or round
-- exactly once and carries the complete sanitized projection.
create or replace function public.broadcast_room_snapshot_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_version bigint;
  v_phase text;
  v_revealed jsonb;
  v_key jsonb;
  v_snapshot jsonb;
begin
  if tg_op = 'DELETE' then return null; end if;
  if tg_op = 'UPDATE'
     and new.phase is not distinct from old.phase
     and new.round_index is not distinct from old.round_index then
    return null;
  end if;

  v_code := new.room_code;
  v_version := new.version;
  v_phase := new.phase;
  v_revealed := new.revealed_employee;
  if new.phase in ('employee_revealed', 'results_displayed', 'complete')
     and new.revealed_employee is not null then
    select jsonb_build_object(
      'key', rtrim(translate(encode(q.reveal_key, 'base64'), '+/', '-_'), '='),
      'iv', rtrim(translate(encode(q.reveal_iv, 'base64'), '+/', '-_'), '='),
      'mimeType', q.reveal_media_mime_type,
      'aad', q.reveal_aad
    ) into v_key
    from public.rooms r
    join public.session_questions q on q.room_id = r.id and q.position = r.current_round
    where r.code = v_code and r.content_mode = 'saved'
      and q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null;
    if v_key is not null then
      v_revealed := v_revealed || jsonb_build_object('revealKey', v_key);
    end if;
  end if;
  v_snapshot := jsonb_build_object(
    'roomCode', new.room_code,
    'phase', new.phase,
    'roundIndex', new.round_index,
    'roundCount', new.round_count,
    'connectedParticipantCount', new.connected_participant_count,
    'eligibleParticipantCount', new.eligible_participant_count,
    'submittedAnswerCount', new.submitted_answer_count,
    'version', new.version,
    'choices', new.choices,
    'prompt', new.prompt,
    'silhouetteUrl', new.silhouette_url,
    'mysteryImageUrl', new.mystery_image_url,
    'preloadAssets', new.preload_assets,
    'revealedEmployee', v_revealed,
    'results', new.results,
    'updatedAt', new.updated_at
  );
  perform realtime.send(
    jsonb_build_object(
      'roomCode', v_code,
      'version', v_version,
      'phase', v_phase,
      'snapshot', v_snapshot
    ),
    'room_snapshot_changed',
    'room:' || v_code,
    true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_room_snapshot_invalidation() from public, anon, authenticated;
revoke all on function public.join_room(text, text, text) from public, anon, authenticated;
revoke all on function public.join_room(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.submit_answer(text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.host_action(text, text, text) from public, anon, authenticated;
grant execute on function public.join_room(text, text, text) to service_role;
grant execute on function public.join_room(text, text, text, uuid) to service_role;
grant execute on function public.submit_answer(text, uuid, text, uuid) to service_role;
grant execute on function public.host_action(text, text, text) to service_role;
