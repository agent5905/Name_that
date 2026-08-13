-- Saved game definitions and immutable repeatable live-session snapshots.
-- Additive only: legacy employee-backed rooms remain supported.

create table public.admin_profiles (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.saved_session_creation_limits (
  source_hash bytea primary key check (octet_length(source_hash) = 32),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0),
  updated_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.admin_profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  revision integer not null default 1 check (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Existing demo rooms do not have a reusable owner/game provenance. They stay
-- fully operational in legacy mode; new repeatable sessions use saved mode.

create index games_owner_updated_idx on public.games(owner_id, updated_at desc);

create table public.game_media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.admin_profiles(id) on delete cascade,
  game_id uuid references public.games(id) on delete set null,
  storage_path text not null unique check (
    storage_path ~ '^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpe?g|png|webp)$'
  ),
  silhouette_storage_path text not null unique check (
    silhouette_storage_path ~ '^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$'
  ),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  silhouette_mime_type text not null check (silhouette_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  created_at timestamptz not null default now()
);


create index game_media_assets_game_idx on public.game_media_assets(game_id);

create table public.game_questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  position integer not null check (position between 0 and 99),
  prompt text not null check (char_length(prompt) between 1 and 160),
  reveal_name text not null check (char_length(reveal_name) between 1 and 100),
  media_asset_id uuid references public.game_media_assets(id) on delete set null,
  unique (game_id, position),
  unique (game_id, id)
);

create table public.game_choices (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.game_questions(id) on delete cascade,
  position integer not null check (position between 0 and 9),
  choice_text text not null check (char_length(choice_text) between 1 and 100),
  is_correct boolean not null default false,
  unique (question_id, position)
);

create unique index game_choices_one_correct_idx on public.game_choices(question_id) where is_correct;

alter table public.rooms
  add column game_id uuid references public.games(id) on delete set null,
  add column game_revision integer,
  add column game_name text,
  add column source_room_id uuid references public.rooms(id) on delete set null,
  add column idempotency_key uuid unique,
  add column content_mode text not null default 'legacy' check (content_mode in ('legacy','saved'));

alter table public.rooms add constraint room_game_snapshot_consistent check (
  (game_id is null and game_revision is null)
  or (game_id is not null and game_revision is not null and game_revision > 0
      and char_length(game_name) between 1 and 100)
);

alter table public.players add column eligible_from_round integer not null default 0
  check (eligible_from_round between 0 and 100);

alter table public.room_snapshots add column eligible_participant_count integer not null default 0
  check (eligible_participant_count >= 0);
alter table public.room_snapshots add column prompt text;
alter table public.room_snapshots add column silhouette_url text;

-- The legacy reveal path returned text. The lifecycle version returns an
-- allowlisted object with its actual MIME, so drop before changing return type.
drop function public.reveal_media_path(text,uuid);

create table public.session_questions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  position integer not null check (position between 0 and 99),
  prompt text not null check (char_length(prompt) between 1 and 160),
  reveal_name text not null check (char_length(reveal_name) between 1 and 100),
  media_path text,
  silhouette_media_path text,
  media_mime_type text check (media_mime_type is null or media_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  silhouette_mime_type text check (silhouette_mime_type is null or silhouette_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  source_employee_id uuid references public.employees(id),
  unique (room_id, position),
  unique (room_id, id)
);

create table public.session_choices (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.session_questions(id) on delete cascade,
  position integer not null check (position between 0 and 9),
  choice_text text not null check (char_length(choice_text) between 1 and 100),
  is_correct boolean not null,
  source_employee_id uuid references public.employees(id),
  unique (question_id, position),
  unique (question_id, id)
);

create unique index session_choices_one_correct_idx on public.session_choices(question_id) where is_correct;

create table public.session_answers (
  room_id uuid not null,
  question_id uuid not null,
  player_id uuid not null,
  choice_id uuid not null,
  submitted_at timestamptz not null default now(),
  primary key (question_id, player_id),
  foreign key (room_id, question_id) references public.session_questions(room_id, id) on delete cascade,
  foreign key (room_id, player_id) references public.players(room_id, id) on delete cascade,
  foreign key (question_id, choice_id) references public.session_choices(question_id, id)
);

create index session_questions_room_idx on public.session_questions(room_id, position);
create index session_answers_room_question_idx on public.session_answers(room_id, question_id);

-- Backfill immutable equivalents for already-existing rooms. Legacy functions
-- continue using their original tables, so applied rooms remain operable.
insert into public.session_questions(id, room_id, position, prompt, reveal_name,
  media_path, silhouette_media_path, media_mime_type, silhouette_mime_type, source_employee_id)
select r.id, r.room_id, r.round_number, 'Name that team member', e.display_name,
  e.storage_path, null, 'image/webp', null, e.id
from public.rounds r join public.employees e on e.id = r.correct_employee_id
on conflict do nothing;

insert into public.session_choices(id, question_id, position, choice_text, is_correct, source_employee_id)
select gen_random_uuid(), c.round_id, c.position, e.display_name,
  c.employee_id = r.correct_employee_id, e.id
from public.round_choices c
join public.rounds r on r.id = c.round_id
join public.employees e on e.id = c.employee_id
on conflict do nothing;

alter table public.admin_profiles enable row level security;
alter table public.saved_session_creation_limits enable row level security;
alter table public.games enable row level security;
alter table public.game_media_assets enable row level security;
alter table public.game_questions enable row level security;
alter table public.game_choices enable row level security;
alter table public.session_questions enable row level security;
alter table public.session_choices enable row level security;
alter table public.session_answers enable row level security;

revoke all on table public.admin_profiles, public.games, public.game_media_assets,
  public.game_questions, public.game_choices, public.session_questions,
  public.session_choices, public.session_answers, public.saved_session_creation_limits from public, anon, authenticated;

create or replace function public.admin_owner_id(p_admin_token_hash text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  if p_admin_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'ADMIN_UNAUTHORIZED';
  end if;
  select id into v_owner from public.admin_profiles
    where token_hash = decode(p_admin_token_hash, 'hex');
  if not found then raise exception using errcode = '42501', message = 'ADMIN_UNAUTHORIZED'; end if;
  update public.admin_profiles set last_seen_at = now() where id = v_owner;
  return v_owner;
end; $$;

create or replace function public.create_admin_profile(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_admin_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  insert into public.admin_profiles(token_hash) values (decode(p_admin_token_hash, 'hex'))
    returning id into v_id;
  return jsonb_build_object('id', v_id);
exception when unique_violation then
  raise exception using errcode = '23505', message = 'TOKEN_COLLISION';
end; $$;

create or replace function public.consume_saved_session_attempt(p_source_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 20; v_window constant interval := interval '15 minutes';
  v_row public.saved_session_creation_limits%rowtype; v_inserted boolean; v_allowed boolean; v_retry_after integer;
begin
  if p_source_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_INPUT'; end if;
  insert into public.saved_session_creation_limits(source_hash,window_started_at,attempts)
    values(decode(p_source_hash,'hex'),now(),1) on conflict(source_hash) do nothing returning * into v_row;
  v_inserted:=found;
  if not v_inserted then select * into strict v_row from public.saved_session_creation_limits where source_hash=decode(p_source_hash,'hex') for update; end if;
  if not v_inserted and v_row.window_started_at<=now()-v_window then
    update public.saved_session_creation_limits set window_started_at=now(),attempts=1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;
  elsif not v_inserted then
    update public.saved_session_creation_limits set attempts=attempts+1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;
  end if;
  v_allowed:=v_row.attempts<=v_limit;
  v_retry_after:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer) end;
  delete from public.saved_session_creation_limits where source_hash<>v_row.source_hash and window_started_at<now()-interval '1 day';
  return jsonb_build_object('allowed',v_allowed,'limit',v_limit,'remaining',greatest(0,v_limit-v_row.attempts),'retryAfterSeconds',v_retry_after);
end; $$;

create or replace function public.validate_game_questions(
  p_owner_id uuid, p_game_id uuid, p_questions jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_question jsonb; v_choice jsonb; v_q_count integer; v_c_count integer; v_correct integer; v_media uuid;
begin
  if jsonb_typeof(p_questions) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_GAME_DEFINITION';
  end if;
  v_q_count := jsonb_array_length(p_questions);
  -- Zero questions is a valid draft. Session creation is the hostability gate.
  if v_q_count < 0 or v_q_count > 100 then
    raise exception using errcode = '22023', message = 'INVALID_QUESTION_COUNT';
  end if;
  for v_question in select value from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(v_question) <> 'object'
       or char_length(btrim(coalesce(v_question->>'prompt', ''))) not between 1 and 160
       or char_length(btrim(coalesce(v_question->>'revealName', ''))) not between 1 and 100
       or coalesce(v_question->>'prompt', '') ~ '[[:cntrl:]]'
       or coalesce(v_question->>'revealName', '') ~ '[[:cntrl:]]'
       or jsonb_typeof(v_question->'choices') <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_QUESTION';
    end if;
    v_c_count := jsonb_array_length(v_question->'choices');
    if v_c_count < 2 or v_c_count > 10 then
      raise exception using errcode = '22023', message = 'INVALID_CHOICE_COUNT';
    end if;
    v_correct := 0;
    for v_choice in select value from jsonb_array_elements(v_question->'choices') loop
      if jsonb_typeof(v_choice) <> 'object'
         or char_length(btrim(coalesce(v_choice->>'text', ''))) not between 1 and 100
         or coalesce(v_choice->>'text', '') ~ '[[:cntrl:]]'
         or jsonb_typeof(v_choice->'isCorrect') <> 'boolean' then
        raise exception using errcode = '22023', message = 'INVALID_CHOICE';
      end if;
      if (v_choice->>'isCorrect')::boolean then v_correct := v_correct + 1; end if;
    end loop;
    if v_correct <> 1 then raise exception using errcode = '22023', message = 'INVALID_CORRECT_CHOICE_COUNT'; end if;
    if v_question ? 'mediaAssetId' and v_question->>'mediaAssetId' is not null then
      begin v_media := (v_question->>'mediaAssetId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'INVALID_MEDIA_ASSET';
      end;
      if not exists (select 1 from public.game_media_assets
          where id = v_media and game_id = p_game_id and owner_id = p_owner_id) then
        raise exception using errcode = '42501', message = 'MEDIA_NOT_OWNED';
      end if;
    end if;
  end loop;
end; $$;

create or replace function public.replace_game_questions(
  p_owner_id uuid, p_game_id uuid, p_questions jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_question jsonb; v_choice jsonb; v_question_id uuid; v_q_pos integer := 0; v_c_pos integer; v_media uuid;
begin
  perform public.validate_game_questions(p_owner_id, p_game_id, p_questions);
  delete from public.game_questions where game_id = p_game_id;
  for v_question in select value from jsonb_array_elements(p_questions) loop
    v_media := null;
    if v_question ? 'mediaAssetId' and v_question->>'mediaAssetId' is not null then
      v_media := (v_question->>'mediaAssetId')::uuid;
    end if;
    insert into public.game_questions(game_id, position, prompt, reveal_name, media_asset_id)
      values (p_game_id, v_q_pos, btrim(v_question->>'prompt'), btrim(v_question->>'revealName'), v_media)
      returning id into v_question_id;
    v_c_pos := 0;
    for v_choice in select value from jsonb_array_elements(v_question->'choices') loop
      insert into public.game_choices(question_id, position, choice_text, is_correct)
        values (v_question_id, v_c_pos, btrim(v_choice->>'text'), (v_choice->>'isCorrect')::boolean);
      v_c_pos := v_c_pos + 1;
    end loop;
    v_q_pos := v_q_pos + 1;
  end loop;
end; $$;

create or replace function public.game_definition_json(p_game_id uuid)
returns jsonb language sql security definer set search_path = public, pg_temp stable as $$
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'revision', g.revision,
    'createdAt', g.created_at, 'updatedAt', g.updated_at,
    'questions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'position', q.position, 'prompt', q.prompt, 'revealName', q.reveal_name,
      'mediaAssetId', q.media_asset_id,
      'mediaPreviewUrl', case when q.media_asset_id is null then null
        else '/api/games/' || g.id || '/media/' || q.media_asset_id end,
      'choices', (select jsonb_agg(jsonb_build_object(
        'id', c.id, 'position', c.position, 'text', c.choice_text, 'isCorrect', c.is_correct
      ) order by c.position) from public.game_choices c where c.question_id = q.id)
    ) order by q.position) from public.game_questions q where q.game_id = g.id), '[]'::jsonb)
  ) from public.games g where g.id = p_game_id;
$$;

create or replace function public.create_game_definition(
  p_admin_token_hash text, p_name text, p_questions jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_game uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if char_length(btrim(p_name)) not between 1 and 100 or p_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'INVALID_GAME_NAME';
  end if;
  if (select count(*) from public.games where owner_id=v_owner and deleted_at is null)>=50 then
    raise exception using errcode='P0001',message='GAME_QUOTA_EXCEEDED';
  end if;
  insert into public.games(owner_id, name) values (v_owner, btrim(p_name)) returning id into v_game;
  perform public.replace_game_questions(v_owner, v_game, p_questions);
  return public.game_definition_json(v_game);
end; $$;

create or replace function public.list_game_definitions(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', g.id, 'name', g.name, 'revision', g.revision,
    'questionCount', (select count(*) from public.game_questions q where q.game_id = g.id),
    'createdAt', g.created_at, 'updatedAt', g.updated_at
  ) order by g.updated_at desc, g.id) from public.games g where g.owner_id = v_owner and g.deleted_at is null), '[]'::jsonb);
end; $$;

create or replace function public.get_game_definition(p_admin_token_hash text, p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if not exists (select 1 from public.games where id = p_game_id and owner_id = v_owner and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'GAME_NOT_FOUND';
  end if;
  return public.game_definition_json(p_game_id);
end; $$;

create or replace function public.update_game_definition(
  p_admin_token_hash text, p_game_id uuid, p_revision integer, p_name text, p_questions jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_current integer;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  select revision into v_current from public.games where id = p_game_id and owner_id = v_owner and deleted_at is null for update;
  if not found then raise exception using errcode = 'P0002', message = 'GAME_NOT_FOUND'; end if;
  if p_revision <> v_current then raise exception using errcode = '40001', message = 'REVISION_CONFLICT'; end if;
  if char_length(btrim(p_name)) not between 1 and 100 or p_name ~ '[[:cntrl:]]' then raise exception using errcode = '22023', message = 'INVALID_GAME_NAME'; end if;
  perform public.replace_game_questions(v_owner, p_game_id, p_questions);
  update public.games set name = btrim(p_name), revision = revision + 1, updated_at = now() where id = p_game_id;
  return public.game_definition_json(p_game_id);
end; $$;

create or replace function public.delete_game_definition(p_admin_token_hash text, p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_paths jsonb;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if not exists (select 1 from public.games where id = p_game_id and owner_id = v_owner and deleted_at is null for update) then
    raise exception using errcode = 'P0002', message = 'GAME_NOT_FOUND';
  end if;
  -- Asset rows and private objects are deliberately retained. Finished/live
  -- session snapshots may still reference their immutable paths; deleting a
  -- saved definition must never break those sessions.
  select '[]'::jsonb into v_paths;
  update public.games set deleted_at=now(),updated_at=now(),revision=revision+1
    where id=p_game_id and owner_id=v_owner;
  return jsonb_build_object('storagePaths', v_paths);
end; $$;

create or replace function public.register_game_media(
  p_admin_token_hash text, p_game_id uuid, p_storage_path text, p_silhouette_storage_path text,
  p_mime_type text, p_silhouette_mime_type text, p_byte_size integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_id uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if not exists (select 1 from public.games where id = p_game_id and owner_id = v_owner and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'GAME_NOT_FOUND';
  end if;
  if (select count(*) from public.game_media_assets m where m.owner_id=v_owner and
        (m.created_at>now()-interval '24 hours' or exists(select 1 from public.game_questions q where q.media_asset_id=m.id)))>=500
     or coalesce((select sum(byte_size) from public.game_media_assets m where m.owner_id=v_owner and
        (m.created_at>now()-interval '24 hours' or exists(select 1 from public.game_questions q where q.media_asset_id=m.id))),0)+p_byte_size>209715200 then
    raise exception using errcode='P0001',message='MEDIA_QUOTA_EXCEEDED';
  end if;
  if p_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}\.(jpe?g|png|webp)$')
     or p_silhouette_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$')
     or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
     or p_silhouette_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
     or p_byte_size not between 1 and 5242880 then
    raise exception using errcode = '22023', message = 'INVALID_MEDIA';
  end if;
  insert into public.game_media_assets(owner_id, game_id, storage_path, silhouette_storage_path, mime_type, silhouette_mime_type, byte_size)
    values (v_owner, p_game_id, p_storage_path, p_silhouette_storage_path, p_mime_type, p_silhouette_mime_type, p_byte_size) returning id into v_id;
  return jsonb_build_object('id', v_id, 'mimeType', p_mime_type, 'byteSize', p_byte_size,
    'previewUrl', '/api/games/' || p_game_id || '/media/' || v_id);
end; $$;

create or replace function public.get_game_media(
  p_admin_token_hash text, p_game_id uuid, p_media_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_media public.game_media_assets%rowtype;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  select * into v_media from public.game_media_assets
    where id = p_media_id and game_id = p_game_id and owner_id = v_owner;
  if not found then raise exception using errcode = 'P0002', message = 'MEDIA_NOT_FOUND'; end if;
  return jsonb_build_object('storagePath', v_media.storage_path, 'silhouetteStoragePath', v_media.silhouette_storage_path, 'mimeType', v_media.mime_type,
    'byteSize', v_media.byte_size);
end; $$;

create or replace function public.refresh_room_snapshot(p_room_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms%rowtype; v_round public.rounds%rowtype; v_question public.session_questions%rowtype;
  v_choices jsonb := '[]'::jsonb; v_reveal jsonb; v_results jsonb;
  v_round_count integer; v_player_count integer; v_eligible_count integer; v_answer_count integer := 0; v_correct uuid;
begin
  select * into strict v_room from public.rooms where id = p_room_id;
  select count(*) into v_player_count from public.players where room_id = p_room_id;
  select count(*) into v_eligible_count from public.players
    where room_id = p_room_id and (v_room.current_round is null or eligible_from_round <= v_room.current_round);
  if v_room.content_mode = 'saved' then
    select count(*) into v_round_count from public.session_questions where room_id = p_room_id;
    if v_room.current_round is not null then
      select * into strict v_question from public.session_questions where room_id = p_room_id and position = v_room.current_round;
      select id into strict v_correct from public.session_choices where question_id = v_question.id and is_correct;
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'displayName', choice_text, 'position', position) order by position), '[]'::jsonb)
        into v_choices from public.session_choices where question_id = v_question.id;
      select count(*) into v_answer_count from public.session_answers where question_id = v_question.id;
      if v_room.phase in ('employee_revealed', 'results_displayed', 'complete') then
        v_reveal := jsonb_build_object('id', v_correct, 'displayName', v_question.reveal_name,
          'team', '', 'funFact', '', 'mediaAvailable', v_question.media_path is not null);
      end if;
      if v_room.phase in ('results_displayed', 'complete') then
        select jsonb_build_object(
          'totalAnswers', (select count(*) from public.session_answers where question_id = v_question.id),
          'correctAnswers', (select count(*) from public.session_answers where question_id = v_question.id and choice_id = v_correct),
          'choices', coalesce(jsonb_agg(jsonb_build_object('employeeId', c.id,
            'count', (select count(*) from public.session_answers a where a.question_id = v_question.id and a.choice_id = c.id)
          ) order by c.position), '[]'::jsonb)
        ) into v_results from public.session_choices c where c.question_id = v_question.id;
      end if;
    end if;
  else
    select count(*) into v_round_count from public.rounds where room_id = p_room_id;
    if v_room.current_round is not null then
      select * into strict v_round from public.rounds where room_id = p_room_id and round_number = v_room.current_round;
      select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'displayName', e.display_name, 'position', c.position) order by c.position), '[]'::jsonb)
        into v_choices from public.round_choices c join public.employees e on e.id = c.employee_id where c.round_id = v_round.id;
      select count(*) into v_answer_count from public.answers where round_id = v_round.id;
      if v_room.phase in ('employee_revealed', 'results_displayed', 'complete') then
        select jsonb_build_object('id', e.id, 'displayName', e.display_name, 'team', e.team, 'funFact', e.fun_fact, 'mediaAvailable', true)
          into v_reveal from public.employees e where e.id = v_round.correct_employee_id;
      end if;
      if v_room.phase in ('results_displayed', 'complete') then
        select jsonb_build_object(
          'totalAnswers', (select count(*) from public.answers where round_id = v_round.id),
          'correctAnswers', (select count(*) from public.answers where round_id = v_round.id and employee_id = v_round.correct_employee_id),
          'choices', coalesce(jsonb_agg(jsonb_build_object('employeeId', c.employee_id,
            'count', (select count(*) from public.answers a where a.round_id = v_round.id and a.employee_id = c.employee_id)
          ) order by c.position), '[]'::jsonb)
        ) into v_results from public.round_choices c where c.round_id = v_round.id;
      end if;
    end if;
  end if;
  insert into public.room_snapshots(room_code, phase, round_index, round_count, connected_participant_count, eligible_participant_count,
    prompt, silhouette_url, submitted_answer_count, version, choices, revealed_employee, results, updated_at)
  values (v_room.code, v_room.phase, v_room.current_round, v_round_count, v_player_count, v_eligible_count,
    case when v_room.content_mode='saved' and v_room.current_round is not null then v_question.prompt else 'Name that team member' end,
    case when v_room.content_mode='saved' and v_room.current_round is not null then '/api/rooms/'||v_room.code||'/silhouette' else null end,
    v_answer_count, v_room.version, v_choices, v_reveal, v_results, now())
  on conflict (room_code) do update set phase=excluded.phase, round_index=excluded.round_index,
    round_count=excluded.round_count, connected_participant_count=excluded.connected_participant_count,
    eligible_participant_count=excluded.eligible_participant_count,prompt=excluded.prompt,silhouette_url=excluded.silhouette_url,
    submitted_answer_count=excluded.submitted_answer_count, version=excluded.version, choices=excluded.choices,
    revealed_employee=excluded.revealed_employee, results=excluded.results, updated_at=excluded.updated_at;
end; $$;

create or replace function public.create_game_session(
  p_admin_token_hash text, p_game_id uuid, p_code text, p_host_token_hash text, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_game public.games%rowtype; v_existing public.rooms%rowtype; v_room uuid; v_q record; v_sq uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if p_code !~ '^[A-HJ-NP-Z2-9]{5}$' or p_host_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023', message='INVALID_INPUT'; end if;
  if p_idempotency_key is null then raise exception using errcode='22023', message='INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_existing from public.rooms where idempotency_key=p_idempotency_key;
  if found then
    if not exists (select 1 from public.games where id=p_game_id and owner_id=v_owner) then
      raise exception using errcode='P0002', message='GAME_NOT_FOUND';
    end if;
    if v_existing.game_id <> p_game_id or v_existing.host_token_hash<>decode(p_host_token_hash,'hex') then raise exception using message='IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('roomId',v_existing.id,'code',v_existing.code,'gameId',v_existing.game_id,
      'gameRevision',v_existing.game_revision,'gameName',v_existing.game_name);
  end if;
  select * into v_game from public.games where id = p_game_id and owner_id = v_owner and deleted_at is null for share;
  if not found then raise exception using errcode='P0002', message='GAME_NOT_FOUND'; end if;
  if (select count(*) from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=v_owner and r.updated_at>now()-interval '24 hours')>=50
     or (select count(*) from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=v_owner and r.phase<>'complete')>=10 then
    raise exception using errcode='P0001',message='SESSION_QUOTA_EXCEEDED';
  end if;
  if exists (select 1 from public.game_questions where game_id = p_game_id and media_asset_id is null) then
    raise exception using errcode='P0001', message='GAME_MEDIA_REQUIRED';
  end if;
  if not exists (select 1 from public.game_questions where game_id = p_game_id) then raise exception using message='CONTENT_UNAVAILABLE'; end if;
  insert into public.rooms(code, host_token_hash, game_id, game_revision, game_name, idempotency_key, content_mode)
    values (p_code, decode(p_host_token_hash,'hex'), p_game_id, v_game.revision, v_game.name, p_idempotency_key, 'saved') returning id into v_room;
  for v_q in select q.*, m.storage_path, m.silhouette_storage_path, m.mime_type, m.silhouette_mime_type from public.game_questions q
      join public.game_media_assets m on m.id=q.media_asset_id where q.game_id=p_game_id order by q.position loop
    insert into public.session_questions(room_id,position,prompt,reveal_name,media_path,silhouette_media_path,media_mime_type,silhouette_mime_type)
      values(v_room,v_q.position,v_q.prompt,v_q.reveal_name,v_q.storage_path,v_q.silhouette_storage_path,v_q.mime_type,v_q.silhouette_mime_type) returning id into v_sq;
    insert into public.session_choices(question_id,position,choice_text,is_correct)
      select v_sq,c.position,c.choice_text,c.is_correct from public.game_choices c where c.question_id=v_q.id order by c.position;
  end loop;
  perform public.refresh_room_snapshot(v_room);
  return jsonb_build_object('roomId',v_room,'code',p_code,'gameId',v_game.id,'gameRevision',v_game.revision,'gameName',v_game.name);
exception when unique_violation then raise exception using errcode='23505', message='CODE_COLLISION';
end; $$;

create or replace function public.play_again_session(
  p_code text, p_host_token_hash text, p_new_code text, p_new_host_token_hash text, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.rooms%rowtype; v_existing public.rooms%rowtype; v_new uuid; v_q record; v_new_q uuid; v_owner uuid;
begin
  if p_new_code !~ '^[A-HJ-NP-Z2-9]{5}$' or p_new_host_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023', message='INVALID_INPUT'; end if;
  if p_idempotency_key is null then raise exception using errcode='22023', message='INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_old from public.rooms where code=p_code for update;
  if not found then raise exception using errcode='P0002', message='ROOM_NOT_FOUND'; end if;
  if v_old.host_token_hash <> decode(p_host_token_hash,'hex') then raise exception using errcode='42501', message='HOST_UNAUTHORIZED'; end if;
  if v_old.phase <> 'complete' then raise exception using message='ILLEGAL_TRANSITION'; end if;
  if v_old.game_id is null then raise exception using message='PLAY_AGAIN_UNAVAILABLE'; end if;
  select owner_id into v_owner from public.games where id=v_old.game_id;
  perform 1 from public.admin_profiles where id=v_owner for update;
  select * into v_existing from public.rooms where source_room_id=v_old.id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.host_token_hash<>decode(p_new_host_token_hash,'hex') then raise exception using message='IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('roomId',v_existing.id,'code',v_existing.code,'gameId',v_existing.game_id,
      'gameRevision',v_existing.game_revision,'gameName',v_existing.game_name);
  end if;
  if (select count(*) from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=v_owner and r.updated_at>now()-interval '24 hours')>=50
     or (select count(*) from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=v_owner and r.phase<>'complete')>=10 then
    raise exception using errcode='P0001',message='SESSION_QUOTA_EXCEEDED';
  end if;
  insert into public.rooms(code,host_token_hash,game_id,game_revision,game_name,source_room_id,idempotency_key,content_mode)
    values(p_new_code,decode(p_new_host_token_hash,'hex'),v_old.game_id,v_old.game_revision,v_old.game_name,v_old.id,p_idempotency_key,'saved') returning id into v_new;
  for v_q in select * from public.session_questions where room_id=v_old.id order by position loop
    insert into public.session_questions(room_id,position,prompt,reveal_name,media_path,silhouette_media_path,media_mime_type,silhouette_mime_type)
      values(v_new,v_q.position,v_q.prompt,v_q.reveal_name,v_q.media_path,v_q.silhouette_media_path,v_q.media_mime_type,v_q.silhouette_mime_type) returning id into v_new_q;
    insert into public.session_choices(question_id,position,choice_text,is_correct)
      select v_new_q,position,choice_text,is_correct from public.session_choices where question_id=v_q.id order by position;
  end loop;
  perform public.refresh_room_snapshot(v_new);
  return jsonb_build_object('roomId',v_new,'code',p_new_code,'gameId',v_old.game_id,'gameRevision',v_old.game_revision,'gameName',v_old.game_name);
exception when unique_violation then raise exception using errcode='23505', message='CODE_COLLISION';
end; $$;

create or replace function public.join_room(p_code text, p_display_name text, p_participant_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_player uuid; v_count integer; v_eligible integer;
begin
  select * into v_room from public.rooms where code=p_code for update;
  if not found then raise exception using errcode='P0002', message='ROOM_NOT_FOUND'; end if;
  if v_room.phase='complete' then raise exception using errcode='P0001', message='GAME_ENDED'; end if;
  if btrim(p_display_name)='' or char_length(btrim(p_display_name))>40 or p_participant_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023', message='INVALID_INPUT'; end if;
  select count(*) into v_count from public.players where room_id=v_room.id;
  if v_count>=100 then raise exception using message='ROOM_FULL'; end if;
  v_eligible := case when v_room.phase='lobby' then 0 when v_room.phase='question_open' then v_room.current_round else v_room.current_round+1 end;
  insert into public.players(room_id,display_name,participant_token_hash,eligible_from_round)
    values(v_room.id,btrim(p_display_name),decode(p_participant_token_hash,'hex'),v_eligible) returning id into v_player;
  update public.rooms set version=version+1,updated_at=now() where id=v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return jsonb_build_object('playerId',v_player,'roomId',v_room.id,'displayName',btrim(p_display_name),'eligibleFromRound',v_eligible);
end; $$;

create or replace function public.submit_answer(p_code text,p_player_id uuid,p_participant_token_hash text,p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_round uuid; v_existing uuid; v_eligible integer;
begin
  select * into v_room from public.rooms where code=p_code for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select eligible_from_round into v_eligible from public.players where id=p_player_id and room_id=v_room.id and participant_token_hash=decode(p_participant_token_hash,'hex');
  if not found then raise exception using errcode='42501',message='PARTICIPANT_UNAUTHORIZED'; end if;
  if v_room.phase<>'question_open' or v_eligible>v_room.current_round then raise exception using message='ANSWERS_CLOSED'; end if;
  if v_room.content_mode = 'saved' then
    select id into strict v_round from public.session_questions where room_id=v_room.id and position=v_room.current_round;
    if not exists(select 1 from public.session_choices where question_id=v_round and id=p_employee_id) then raise exception using errcode='22023',message='INVALID_CHOICE'; end if;
    select choice_id into v_existing from public.session_answers where question_id=v_round and player_id=p_player_id;
    if found then
      if v_existing<>p_employee_id then raise exception using message='ANSWER_IMMUTABLE'; end if;
      return jsonb_build_object('accepted',true,'idempotent',true,'employeeId',v_existing);
    end if;
    insert into public.session_answers(room_id,question_id,player_id,choice_id) values(v_room.id,v_round,p_player_id,p_employee_id);
  else
    select id into strict v_round from public.rounds where room_id=v_room.id and round_number=v_room.current_round;
    if not exists(select 1 from public.round_choices where round_id=v_round and employee_id=p_employee_id) then raise exception using errcode='22023',message='INVALID_CHOICE'; end if;
    select employee_id into v_existing from public.answers where round_id=v_round and player_id=p_player_id;
    if found then
      if v_existing<>p_employee_id then raise exception using message='ANSWER_IMMUTABLE'; end if;
      return jsonb_build_object('accepted',true,'idempotent',true,'employeeId',v_existing);
    end if;
    insert into public.answers(room_id,round_id,player_id,employee_id) values(v_room.id,v_round,p_player_id,p_employee_id);
  end if;
  update public.rooms set version=version+1,updated_at=now() where id=v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return jsonb_build_object('accepted',true,'idempotent',false,'employeeId',p_employee_id);
end; $$;

create or replace function public.participant_answer(p_code text,p_player_id uuid,p_participant_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_round uuid; v_answer uuid; v_eligible integer;
begin
  select * into v_room from public.rooms where code=p_code;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select eligible_from_round into v_eligible from public.players where id=p_player_id and room_id=v_room.id and participant_token_hash=decode(p_participant_token_hash,'hex');
  if not found then raise exception using errcode='42501',message='PARTICIPANT_UNAUTHORIZED'; end if;
  if v_room.current_round is not null then
    if v_room.content_mode = 'saved' then
      select id into v_round from public.session_questions where room_id=v_room.id and position=v_room.current_round;
      select choice_id into v_answer from public.session_answers where question_id=v_round and player_id=p_player_id;
    else
      select id into v_round from public.rounds where room_id=v_room.id and round_number=v_room.current_round;
      select employee_id into v_answer from public.answers where round_id=v_round and player_id=p_player_id;
    end if;
  end if;
  return jsonb_build_object('employeeId',v_answer,'eligibleFromRound',v_eligible);
end; $$;

create or replace function public.host_room(p_code text,p_host_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_correct jsonb; v_count integer;
begin
  select * into v_room from public.rooms where code=p_code;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if v_room.host_token_hash<>decode(p_host_token_hash,'hex') then raise exception using errcode='42501',message='HOST_UNAUTHORIZED'; end if;
  if v_room.content_mode = 'saved' then
    select count(*) into v_count from public.session_questions where room_id=v_room.id;
    if v_room.current_round is not null then
      select jsonb_build_object('id',c.id,'displayName',q.reveal_name,'team','') into v_correct
        from public.session_questions q join public.session_choices c on c.question_id=q.id and c.is_correct
        where q.room_id=v_room.id and q.position=v_room.current_round;
    end if;
  else
    select count(*) into v_count from public.rounds where room_id=v_room.id;
    if v_room.current_round is not null then
      select jsonb_build_object('id',e.id,'displayName',e.display_name,'team',e.team) into v_correct
        from public.rounds r join public.employees e on e.id=r.correct_employee_id where r.room_id=v_room.id and r.round_number=v_room.current_round;
    end if;
  end if;
  return jsonb_build_object('roomId',v_room.id,'code',v_room.code,'phase',v_room.phase,'currentRound',v_room.current_round,
    'roundCount',v_count,'isFinalRound',v_room.current_round is not null and v_room.current_round=v_count-1,
    'correctEmployee',v_correct,'version',v_room.version,'gameId',v_room.game_id,'gameRevision',v_room.game_revision,'gameName',v_room.game_name);
end; $$;

create or replace function public.reveal_media_path(p_code text,p_member_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_path text; v_mime text := 'image/webp';
begin
  select * into v_room from public.rooms where code=p_code;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if v_room.phase not in ('employee_revealed','results_displayed','complete') then raise exception using message='MEDIA_NOT_REVEALED'; end if;
  if v_room.content_mode = 'saved' then
    select q.media_path,q.media_mime_type into v_path,v_mime from public.session_questions q join public.session_choices c on c.question_id=q.id and c.is_correct
      where q.room_id=v_room.id and q.position=v_room.current_round and c.id=p_member_id;
  else
    select e.storage_path into v_path from public.rounds r join public.employees e on e.id=r.correct_employee_id
      where r.room_id=v_room.id and r.round_number=v_room.current_round and e.id=p_member_id;
  end if;
  if v_path is null then raise exception using message='MEDIA_NOT_REVEALED'; end if;
  return jsonb_build_object('storagePath',v_path,'mimeType',v_mime);
end; $$;

create or replace function public.silhouette_media_path(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_question public.session_questions%rowtype;
begin
  select * into v_room from public.rooms where code=p_code;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if v_room.content_mode<>'saved' or v_room.current_round is null or v_room.phase not in ('question_open','answers_locked') then
    raise exception using message='MEDIA_NOT_REVEALED';
  end if;
  select * into v_question from public.session_questions where room_id=v_room.id and position=v_room.current_round;
  if v_question.silhouette_media_path is null then raise exception using message='MEDIA_NOT_REVEALED'; end if;
  return jsonb_build_object('storagePath',v_question.silhouette_media_path,'mimeType',v_question.silhouette_mime_type);
end; $$;

create or replace function public.host_action(p_code text,p_host_token_hash text,p_action text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms%rowtype; v_last integer;
begin
  select * into v_room from public.rooms where code=p_code for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if v_room.host_token_hash<>decode(p_host_token_hash,'hex') then raise exception using errcode='42501',message='HOST_UNAUTHORIZED'; end if;
  if v_room.content_mode='saved' then select max(position) into v_last from public.session_questions where room_id=v_room.id;
  else select max(round_number) into v_last from public.rounds where room_id=v_room.id; end if;
  case p_action
    when 'start' then
      if v_room.phase<>'lobby' or v_last is null then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='question_open';v_room.current_round:=0;
    when 'lock' then
      if v_room.phase<>'question_open' then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='answers_locked';
    when 'reveal' then
      if v_room.phase<>'answers_locked' then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='employee_revealed';
    when 'show_results' then
      if v_room.phase<>'employee_revealed' then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='results_displayed';
    when 'next_round' then
      if v_room.phase<>'results_displayed' or v_room.current_round>=v_last then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='question_open';v_room.current_round:=v_room.current_round+1;
    when 'end' then
      if v_room.phase<>'results_displayed' or v_room.current_round<>v_last then raise exception using message='ILLEGAL_TRANSITION'; end if;
      v_room.phase:='complete';
    else raise exception using errcode='22023',message='INVALID_ACTION';
  end case;
  update public.rooms set phase=v_room.phase,current_round=v_room.current_round,version=version+1,updated_at=now() where id=v_room.id;
  perform public.refresh_room_snapshot(v_room.id);
  return (select to_jsonb(s) from public.room_snapshots s where room_code=p_code);
end; $$;

-- Private bucket now supports admin-provided source formats. Access remains
-- server-only under the existing restrictive storage policy.
update storage.buckets set public=false,file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'] where id='reveal-media';

revoke all on function public.admin_owner_id(text), public.create_admin_profile(text),
  public.consume_saved_session_attempt(text),
  public.validate_game_questions(uuid,uuid,jsonb), public.replace_game_questions(uuid,uuid,jsonb),
  public.game_definition_json(uuid), public.create_game_definition(text,text,jsonb),
  public.list_game_definitions(text), public.get_game_definition(text,uuid),
  public.update_game_definition(text,uuid,integer,text,jsonb), public.delete_game_definition(text,uuid),
  public.register_game_media(text,uuid,text,text,text,text,integer), public.get_game_media(text,uuid,uuid),
  public.create_game_session(text,uuid,text,text,uuid), public.play_again_session(text,text,text,text,uuid)
  from public, anon, authenticated;
revoke all on function public.join_room(text,text,text), public.submit_answer(text,uuid,text,uuid),
  public.participant_answer(text,uuid,text), public.host_room(text,text), public.reveal_media_path(text,uuid), public.silhouette_media_path(text)
  from public, anon, authenticated;

grant execute on function public.create_admin_profile(text), public.create_game_definition(text,text,jsonb),
  public.admin_owner_id(text),
  public.consume_saved_session_attempt(text),
  public.list_game_definitions(text), public.get_game_definition(text,uuid),
  public.update_game_definition(text,uuid,integer,text,jsonb), public.delete_game_definition(text,uuid),
  public.register_game_media(text,uuid,text,text,text,text,integer), public.get_game_media(text,uuid,uuid),
  public.create_game_session(text,uuid,text,text,uuid), public.play_again_session(text,text,text,text,uuid),
  public.join_room(text,text,text), public.submit_answer(text,uuid,text,uuid),
  public.participant_answer(text,uuid,text), public.host_room(text,text), public.reveal_media_path(text,uuid), public.silhouette_media_path(text)
  to service_role;
