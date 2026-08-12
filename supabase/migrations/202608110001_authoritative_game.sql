-- Authoritative game state. This migration is intentionally self-contained and reversible.
create extension if not exists pgcrypto with schema extensions;

create type public.game_phase as enum (
  'lobby', 'question_open', 'answers_locked', 'employee_revealed',
  'results_displayed', 'complete'
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  team text not null check (char_length(team) between 1 and 80),
  fun_fact text not null check (char_length(fun_fact) between 1 and 240),
  storage_path text not null unique check (storage_path ~ '^portraits/[a-z0-9-]+\.webp$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{5}$'),
  host_token_hash bytea not null unique check (octet_length(host_token_hash) = 32),
  phase public.game_phase not null default 'lobby',
  current_round integer,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((phase = 'lobby' and current_round is null) or phase <> 'lobby')
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  participant_token_hash bytea not null unique check (octet_length(participant_token_hash) = 32),
  joined_at timestamptz not null default now(),
  unique (room_id, id)
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number integer not null check (round_number >= 0),
  correct_employee_id uuid not null references public.employees(id),
  unique (room_id, round_number),
  unique (room_id, id)
);

create table public.round_choices (
  round_id uuid not null references public.rounds(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  position smallint not null check (position between 0 and 3),
  primary key (round_id, employee_id),
  unique (round_id, position)
);

create table public.answers (
  room_id uuid not null,
  round_id uuid not null,
  player_id uuid not null,
  employee_id uuid not null,
  submitted_at timestamptz not null default now(),
  primary key (round_id, player_id),
  foreign key (room_id, round_id) references public.rounds(room_id, id) on delete cascade,
  foreign key (room_id, player_id) references public.players(room_id, id) on delete cascade,
  foreign key (round_id, employee_id) references public.round_choices(round_id, employee_id)
);

-- Server-owned sanitized projection returned through the code-scoped HTTP API.
create table public.room_snapshots (
  room_code text primary key,
  phase public.game_phase not null,
  round_index integer,
  round_count integer not null,
  connected_participant_count integer not null,
  submitted_answer_count integer not null,
  version bigint not null,
  choices jsonb not null default '[]'::jsonb,
  revealed_employee jsonb,
  results jsonb,
  updated_at timestamptz not null default now(),
  check (revealed_employee is null or phase in ('employee_revealed', 'results_displayed', 'complete')),
  check (results is null or phase in ('results_displayed', 'complete'))
);

create table public.room_creation_limits (
  source_hash bytea primary key check (octet_length(source_hash) = 32),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0),
  updated_at timestamptz not null default now()
);

create index players_room_id_idx on public.players(room_id);
create index rounds_room_id_idx on public.rounds(room_id, round_number);
create index answers_room_round_idx on public.answers(room_id, round_id);
create index room_creation_limits_window_idx on public.room_creation_limits(window_started_at);

alter table public.employees enable row level security;
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.rounds enable row level security;
alter table public.round_choices enable row level security;
alter table public.answers enable row level security;
alter table public.room_snapshots enable row level security;
alter table public.room_creation_limits enable row level security;

revoke all on table public.employees, public.rooms, public.players, public.rounds,
  public.round_choices, public.answers, public.room_snapshots,
  public.room_creation_limits from public, anon, authenticated;

-- Future objects start closed even if a later migration forgets explicit grants.
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

create or replace function public.consume_room_creation_attempt(p_source_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 5;
  v_window constant interval := interval '15 minutes';
  v_row public.room_creation_limits%rowtype;
  v_inserted boolean;
  v_allowed boolean;
  v_retry_after integer;
begin
  if p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;

  insert into public.room_creation_limits(source_hash, window_started_at, attempts)
    values (decode(p_source_hash, 'hex'), now(), 1)
    on conflict (source_hash) do nothing returning * into v_row;
  v_inserted := found;
  if not v_inserted then
    select * into strict v_row from public.room_creation_limits
      where source_hash = decode(p_source_hash, 'hex') for update;
  end if;

  if not v_inserted and v_row.window_started_at <= now() - v_window then
    update public.room_creation_limits set window_started_at = now(), attempts = 1, updated_at = now()
      where source_hash = v_row.source_hash
      returning * into v_row;
  elsif not v_inserted then
    update public.room_creation_limits set attempts = attempts + 1, updated_at = now()
      where source_hash = v_row.source_hash
      returning * into v_row;
  end if;

  v_allowed := v_row.attempts <= v_limit;
  v_retry_after := case when v_allowed then 0 else greatest(1,
    ceil(extract(epoch from (v_row.window_started_at + v_window - now())))::integer) end;

  delete from public.room_creation_limits
    where source_hash <> v_row.source_hash and window_started_at < now() - interval '1 day';

  return jsonb_build_object('allowed', v_allowed, 'limit', v_limit,
    'remaining', greatest(0, v_limit - v_row.attempts),
    'retryAfterSeconds', v_retry_after);
end; $$;

create or replace function public.cleanup_expired_rooms()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room_ids uuid[];
  v_room_codes text[];
  v_room_count integer := 0;
  v_snapshot_count integer := 0;
begin
  select array_agg(id order by id), array_agg(code order by id) into v_room_ids, v_room_codes
    from (
      select id, code from public.rooms
      where (phase = 'complete' and updated_at < now() - interval '12 hours')
         or updated_at < now() - interval '24 hours'
      for update skip locked
    ) expired;

  if coalesce(array_length(v_room_ids, 1), 0) = 0 then
    return jsonb_build_object('deletedRooms', 0, 'deletedSnapshots', 0);
  end if;

  delete from public.room_snapshots where room_code = any(v_room_codes);
  get diagnostics v_snapshot_count = row_count;
  delete from public.rooms where id = any(v_room_ids);
  get diagnostics v_room_count = row_count;
  return jsonb_build_object('deletedRooms', v_room_count, 'deletedSnapshots', v_snapshot_count);
end; $$;

create or replace function public.refresh_room_snapshot(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_round public.rounds%rowtype;
  v_choices jsonb := '[]'::jsonb;
  v_reveal jsonb;
  v_results jsonb;
  v_round_count integer;
  v_player_count integer;
  v_answer_count integer := 0;
begin
  select * into strict v_room from public.rooms where id = p_room_id;
  select count(*) into v_round_count from public.rounds where room_id = p_room_id;
  select count(*) into v_player_count from public.players where room_id = p_room_id;

  if v_room.current_round is not null then
    select * into strict v_round from public.rounds
      where room_id = p_room_id and round_number = v_room.current_round;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'displayName', e.display_name, 'position', c.position
    ) order by c.position), '[]'::jsonb)
      into v_choices
      from public.round_choices c join public.employees e on e.id = c.employee_id
      where c.round_id = v_round.id;
    select count(*) into v_answer_count from public.answers where round_id = v_round.id;

    if v_room.phase in ('employee_revealed', 'results_displayed', 'complete') then
      select jsonb_build_object('id', e.id, 'displayName', e.display_name,
        'team', e.team, 'funFact', e.fun_fact, 'mediaAvailable', true)
        into v_reveal from public.employees e where e.id = v_round.correct_employee_id;
    end if;

    if v_room.phase in ('results_displayed', 'complete') then
      select jsonb_build_object(
        'totalAnswers', (select count(*) from public.answers a where a.round_id = v_round.id),
        'correctAnswers', (select count(*) from public.answers a where a.round_id = v_round.id and a.employee_id = v_round.correct_employee_id),
        'choices', coalesce(jsonb_agg(jsonb_build_object(
          'employeeId', c.employee_id,
          'count', (select count(*) from public.answers a2 where a2.round_id = v_round.id and a2.employee_id = c.employee_id)
        ) order by c.position), '[]'::jsonb)
      ) into v_results
      from public.round_choices c
      where c.round_id = v_round.id;
    end if;
  end if;

  insert into public.room_snapshots(room_code, phase, round_index, round_count,
    connected_participant_count, submitted_answer_count, version, choices,
    revealed_employee, results, updated_at)
  values (v_room.code, v_room.phase, v_room.current_round, v_round_count,
    v_player_count, v_answer_count, v_room.version, v_choices, v_reveal, v_results, now())
  on conflict (room_code) do update set phase = excluded.phase,
    round_index = excluded.round_index, round_count = excluded.round_count,
    connected_participant_count = excluded.connected_participant_count,
    submitted_answer_count = excluded.submitted_answer_count, version = excluded.version,
    choices = excluded.choices, revealed_employee = excluded.revealed_employee,
    results = excluded.results, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.create_room(p_code text, p_host_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_room_id uuid; v_employee record; v_round integer := 0; v_active_count integer;
begin
  if p_code !~ '^[A-HJ-NP-Z2-9]{5}$' or p_host_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  select count(*) into v_active_count from public.employees where active;
  if v_active_count < 4 then raise exception using errcode = 'P0001', message = 'CONTENT_UNAVAILABLE'; end if;
  insert into public.rooms(code, host_token_hash) values (p_code, decode(p_host_token_hash, 'hex')) returning id into v_room_id;
  -- pgcrypto supplies independent database CSPRNG bytes for every room sequence.
  for v_employee in select id from public.employees where active order by gen_random_bytes(16) loop
    insert into public.rounds(room_id, round_number, correct_employee_id)
      values (v_room_id, v_round, v_employee.id);
    with candidates as (
      select v_employee.id::uuid as employee_id
      union all
      (select e.id from public.employees e
        where e.active and e.id <> v_employee.id
        order by gen_random_bytes(16) limit 3)
    ), positioned as (
      select employee_id, (row_number() over (
        order by gen_random_bytes(16)
      ) - 1)::smallint as position from candidates
    )
    insert into public.round_choices(round_id, employee_id, position)
      select r.id, p.employee_id, p.position from public.rounds r cross join positioned p
      where r.room_id = v_room_id and r.round_number = v_round;
    v_round := v_round + 1;
  end loop;
  if v_round < 1 then raise exception using errcode = 'P0001', message = 'CONTENT_UNAVAILABLE'; end if;
  perform public.refresh_room_snapshot(v_room_id);
  return jsonb_build_object('roomId', v_room_id, 'code', p_code);
exception when unique_violation then
  raise exception using errcode = '23505', message = 'CODE_COLLISION';
end; $$;

create or replace function public.join_room(p_code text, p_display_name text, p_participant_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_player_id uuid; v_player_count integer;
begin
  select * into v_room from public.rooms where code = p_code for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.phase <> 'lobby' then raise exception using errcode = 'P0001', message = 'ROOM_NOT_JOINABLE'; end if;
  if btrim(p_display_name) = '' or char_length(btrim(p_display_name)) > 40 or p_participant_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  select count(*) into v_player_count from public.players where room_id = v_room.id;
  if v_player_count >= 100 then raise exception using errcode = 'P0001', message = 'ROOM_FULL'; end if;
  insert into public.players(room_id, display_name, participant_token_hash)
    values (v_room.id, btrim(p_display_name), decode(p_participant_token_hash, 'hex')) returning id into v_player_id;
  update public.rooms set version = version + 1, updated_at = now() where id = v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return jsonb_build_object('playerId', v_player_id, 'roomId', v_room.id, 'displayName', btrim(p_display_name));
end; $$;

create or replace function public.submit_answer(p_code text, p_player_id uuid, p_participant_token_hash text, p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_round_id uuid; v_existing uuid;
begin
  select * into v_room from public.rooms where code = p_code for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if not exists (select 1 from public.players where id = p_player_id and room_id = v_room.id
      and participant_token_hash = decode(p_participant_token_hash, 'hex')) then
    raise exception using errcode = '42501', message = 'PARTICIPANT_UNAUTHORIZED';
  end if;
  if v_room.phase <> 'question_open' then raise exception using errcode = 'P0001', message = 'ANSWERS_CLOSED'; end if;
  select id into strict v_round_id from public.rounds where room_id = v_room.id and round_number = v_room.current_round;
  if not exists (select 1 from public.round_choices where round_id = v_round_id and employee_id = p_employee_id) then
    raise exception using errcode = '22023', message = 'INVALID_CHOICE';
  end if;
  select employee_id into v_existing from public.answers where round_id = v_round_id and player_id = p_player_id;
  if found then
    if v_existing <> p_employee_id then raise exception using errcode = 'P0001', message = 'ANSWER_IMMUTABLE'; end if;
    return jsonb_build_object('accepted', true, 'idempotent', true, 'employeeId', v_existing);
  end if;
  insert into public.answers(room_id, round_id, player_id, employee_id)
    values (v_room.id, v_round_id, p_player_id, p_employee_id);
  update public.rooms set version = version + 1, updated_at = now() where id = v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return jsonb_build_object('accepted', true, 'idempotent', false, 'employeeId', p_employee_id);
end; $$;

create or replace function public.host_action(p_code text, p_host_token_hash text, p_action text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_last integer;
begin
  select * into v_room from public.rooms where code = p_code for update;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.host_token_hash <> decode(p_host_token_hash, 'hex') then
    raise exception using errcode = '42501', message = 'HOST_UNAUTHORIZED';
  end if;
  select max(round_number) into v_last from public.rounds where room_id = v_room.id;
  case p_action
    when 'start' then
      if v_room.phase <> 'lobby' then raise exception using message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'question_open'; v_room.current_round := 0;
    when 'lock' then
      if v_room.phase <> 'question_open' then raise exception using message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'answers_locked';
    when 'reveal' then
      if v_room.phase <> 'answers_locked' then raise exception using message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'employee_revealed';
    when 'show_results' then
      if v_room.phase <> 'employee_revealed' then raise exception using message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'results_displayed';
    when 'next_round' then
      if v_room.phase <> 'results_displayed' or v_room.current_round >= v_last then
        raise exception using message = 'ILLEGAL_TRANSITION';
      end if;
      v_room.phase := 'question_open'; v_room.current_round := v_room.current_round + 1;
    when 'end' then
      if v_room.phase <> 'results_displayed' then raise exception using message = 'ILLEGAL_TRANSITION'; end if;
      v_room.phase := 'complete';
    else raise exception using errcode = '22023', message = 'INVALID_ACTION';
  end case;
  update public.rooms set phase = v_room.phase, current_round = v_room.current_round,
    version = version + 1, updated_at = now() where id = v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return (select to_jsonb(s) from public.room_snapshots s where room_code = p_code);
end; $$;

create or replace function public.host_room(p_code text, p_host_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms%rowtype;
  v_correct_employee jsonb;
  v_round_count integer;
begin
  select * into v_room from public.rooms where code = p_code;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.host_token_hash <> decode(p_host_token_hash, 'hex') then raise exception using errcode = '42501', message = 'HOST_UNAUTHORIZED'; end if;
  select count(*) into v_round_count from public.rounds where room_id = v_room.id;
  if v_room.current_round is not null then
    select jsonb_build_object('id', e.id, 'displayName', e.display_name, 'team', e.team)
      into v_correct_employee
      from public.rounds r join public.employees e on e.id = r.correct_employee_id
      where r.room_id = v_room.id and r.round_number = v_room.current_round;
  end if;
  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'phase', v_room.phase,
    'currentRound', v_room.current_round, 'roundCount', v_round_count,
    'isFinalRound', v_room.current_round is not null and v_room.current_round = v_round_count - 1,
    'correctEmployee', v_correct_employee, 'version', v_room.version);
end; $$;

create or replace function public.participant_answer(p_code text, p_player_id uuid, p_participant_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_answer uuid;
begin
  select * into v_room from public.rooms where code = p_code;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if not exists (select 1 from public.players where id = p_player_id and room_id = v_room.id
      and participant_token_hash = decode(p_participant_token_hash, 'hex')) then
    raise exception using errcode = '42501', message = 'PARTICIPANT_UNAUTHORIZED';
  end if;
  select a.employee_id into v_answer from public.answers a join public.rounds r on r.id = a.round_id
    where a.player_id = p_player_id and r.room_id = v_room.id and r.round_number = v_room.current_round;
  return jsonb_build_object('employeeId', v_answer);
end; $$;

create or replace function public.reveal_media_path(p_code text, p_member_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_correct uuid; v_path text;
begin
  select * into v_room from public.rooms where code = p_code;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if v_room.phase not in ('employee_revealed', 'results_displayed', 'complete') then
    raise exception using errcode = '42501', message = 'MEDIA_NOT_REVEALED';
  end if;
  select correct_employee_id into v_correct from public.rounds
    where room_id = v_room.id and round_number = v_room.current_round;
  if v_correct <> p_member_id then raise exception using errcode = '42501', message = 'MEDIA_NOT_REVEALED'; end if;
  select storage_path into v_path from public.employees where id = p_member_id;
  return v_path;
end; $$;

revoke all on function public.refresh_room_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.consume_room_creation_attempt(text), public.cleanup_expired_rooms()
  from public, anon, authenticated;
revoke all on function public.create_room(text, text), public.join_room(text, text, text),
  public.submit_answer(text, uuid, text, uuid), public.host_action(text, text, text),
  public.host_room(text, text), public.participant_answer(text, uuid, text),
  public.reveal_media_path(text, uuid) from public, anon, authenticated;
grant execute on function public.create_room(text, text), public.join_room(text, text, text),
  public.submit_answer(text, uuid, text, uuid), public.host_action(text, text, text),
  public.host_room(text, text), public.participant_answer(text, uuid, text),
  public.reveal_media_path(text, uuid) to service_role;
grant execute on function public.consume_room_creation_attempt(text), public.cleanup_expired_rooms()
  to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('reveal-media', 'reveal-media', false, 2097152, array['image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Restrictive means this scoped deny still wins if another permissive Storage
-- policy is added later; it does not restrict other buckets.
create policy reveal_media_never_client_select on storage.objects
  as restrictive for select to anon, authenticated
  using (bucket_id <> 'reveal-media');

-- Private, code-scoped Broadcast carries invalidation only. Snapshot bytes stay
-- behind the Pages API and are always refetched after an event.
create policy room_snapshot_broadcast_receive on realtime.messages
  for select to anon, authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'
  );

-- Restrictive makes room invalidation channels receive-only even if another
-- permissive INSERT policy is introduced for unrelated Realtime features.
create policy room_snapshot_broadcast_client_send_deny on realtime.messages
  as restrictive for insert to anon, authenticated
  with check (
    extension <> 'broadcast'
    or realtime.topic() !~ '^room:[A-HJ-NP-Z2-9]{5}$'
  );

create or replace function public.broadcast_room_snapshot_invalidation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_code text := coalesce(new.room_code, old.room_code);
  v_version bigint := coalesce(new.version, old.version);
begin
  perform realtime.send(
    jsonb_build_object('roomCode', v_code, 'version', v_version),
    'room_snapshot_changed',
    'room:' || v_code,
    true
  );
  return null;
end; $$;

revoke all on function public.broadcast_room_snapshot_invalidation() from public, anon, authenticated;
create trigger room_snapshot_broadcast
after insert or update or delete on public.room_snapshots
for each row execute function public.broadcast_room_snapshot_invalidation();
