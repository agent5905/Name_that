-- Transactional source/project budgets prevent owner rotation from multiplying
-- saved-definition growth or poisoning admission with failed requests.

create table public.game_source_daily_budgets(
  source_hash bytea primary key check(octet_length(source_hash)=32),
  window_started_at timestamptz not null,
  mutations integer not null check(mutations>0),
  updated_at timestamptz not null default now()
);
create table public.game_project_daily_budget(
  singleton boolean primary key default true check(singleton),
  window_started_at timestamptz not null,
  mutations integer not null check(mutations>0),
  updated_at timestamptz not null default now()
);
alter table public.game_source_daily_budgets enable row level security;
alter table public.game_project_daily_budget enable row level security;
revoke all on table public.game_source_daily_budgets,public.game_project_daily_budget from public,anon,authenticated;

create or replace function public.admit_game_mutation(p_source_hash text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_source_limit constant integer:=100;v_project_limit constant integer:=1000;v_window constant interval:=interval '1 day';v_source public.game_source_daily_budgets%rowtype;v_project public.game_project_daily_budget%rowtype;
begin
  if p_source_hash!~'^[0-9a-f]{64}$'then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('saved-game-daily-project-budget',0));
  select * into v_project from public.game_project_daily_budget where singleton=true for update;
  if not found or v_project.window_started_at<=now()-v_window then
    insert into public.game_project_daily_budget(singleton,window_started_at,mutations)values(true,now(),1)
      on conflict(singleton)do update set window_started_at=excluded.window_started_at,mutations=1,updated_at=now();
  elsif v_project.mutations>=v_project_limit then
    raise exception using errcode='P0001',message='PROJECT_GAME_DAILY_LIMITED';
  else update public.game_project_daily_budget set mutations=mutations+1,updated_at=now()where singleton=true;end if;
  select * into v_source from public.game_source_daily_budgets where source_hash=decode(p_source_hash,'hex') for update;
  if not found or v_source.window_started_at<=now()-v_window then
    insert into public.game_source_daily_budgets(source_hash,window_started_at,mutations)values(decode(p_source_hash,'hex'),now(),1)
      on conflict(source_hash)do update set window_started_at=excluded.window_started_at,mutations=1,updated_at=now();
  elsif v_source.mutations>=v_source_limit then
    raise exception using errcode='P0001',message='GAME_SOURCE_DAILY_LIMITED';
  else update public.game_source_daily_budgets set mutations=mutations+1,updated_at=now()where source_hash=v_source.source_hash;end if;
end;$$;

create or replace function public.create_game_definition(p_admin_token_hash text,p_source_hash text,p_name text,p_questions jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_game uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);perform public.admit_game_mutation(p_source_hash);
  if char_length(btrim(p_name))not between 1 and 100 or p_name~'[[:cntrl:]]'then raise exception using errcode='22023',message='INVALID_GAME_NAME';end if;
  perform pg_advisory_xact_lock(hashtextextended('saved-game-project-quota',0));
  if(select count(*)from public.games)>=8000 then raise exception using errcode='P0001',message='PROJECT_GAME_CAPACITY_REACHED';end if;
  if(select count(*)from public.games where owner_id=v_owner)>=200 or(select count(*)from public.games where owner_id=v_owner and deleted_at is null)>=50 then raise exception using errcode='P0001',message='GAME_QUOTA_EXCEEDED';end if;
  insert into public.games(owner_id,name)values(v_owner,btrim(p_name))returning id into v_game;
  perform public.replace_game_questions(v_owner,v_game,p_questions);return public.game_definition_json(v_game);
end;$$;

create or replace function public.update_game_definition(p_admin_token_hash text,p_source_hash text,p_game_id uuid,p_revision integer,p_name text,p_questions jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_current integer;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);perform public.admit_game_mutation(p_source_hash);
  select revision into v_current from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null for update;
  if not found then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
  if p_revision<>v_current then raise exception using errcode='40001',message='REVISION_CONFLICT';end if;
  if char_length(btrim(p_name))not between 1 and 100 or p_name~'[[:cntrl:]]'then raise exception using errcode='22023',message='INVALID_GAME_NAME';end if;
  perform public.replace_game_questions(v_owner,p_game_id,p_questions);
  update public.games set name=btrim(p_name),revision=revision+1,updated_at=now()where id=p_game_id;
  return public.game_definition_json(p_game_id);
end;$$;

create or replace function public.delete_game_definition(p_admin_token_hash text,p_source_hash text,p_game_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);perform public.admit_game_mutation(p_source_hash);
  if not exists(select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null for update)then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
  update public.games set deleted_at=now(),updated_at=now(),revision=revision+1 where id=p_game_id and owner_id=v_owner;
  delete from public.game_questions where game_id=p_game_id;
  return jsonb_build_object('storagePaths','[]'::jsonb);
end;$$;

create or replace function public.cleanup_stale_studio_state()
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare v_admin integer;v_sources integer;v_games integer;
begin
  delete from public.admin_profile_creation_limits where window_started_at<now()-interval '1 day';get diagnostics v_sources=row_count;
  delete from public.media_source_upload_limits where window_started_at<now()-interval '2 days';delete from public.media_source_byte_limits where window_started_at<now()-interval '3 days';
  delete from public.game_source_daily_budgets where window_started_at<now()-interval '2 days';delete from public.saved_session_creation_limits where window_started_at<now()-interval '1 day';
  delete from public.media_upload_limits where window_started_at<now()-interval '2 days';delete from public.game_mutation_limits where window_started_at<now()-interval '2 days';
  delete from public.games g where g.deleted_at<now()-interval '1 day'and not exists(select 1 from public.rooms r where r.game_id=g.id);get diagnostics v_games=row_count;
  delete from public.admin_profiles a where a.last_seen_at<now()-interval '30 days'and not exists(select 1 from public.games g where g.owner_id=a.id)and not exists(select 1 from public.game_media_assets m where m.owner_id=a.id);get diagnostics v_admin=row_count;
  return jsonb_build_object('deletedProfiles',v_admin,'deletedExpiredSources',v_sources,'deletedGames',v_games);
end;$$;

revoke all on function public.admit_game_mutation(text),public.create_game_definition(text,text,text,jsonb),
  public.update_game_definition(text,text,uuid,integer,text,jsonb),public.delete_game_definition(text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.create_game_definition(text,text,text,jsonb),
  public.update_game_definition(text,text,uuid,integer,text,jsonb),public.delete_game_definition(text,text,uuid)
  to service_role;
