-- Bound definition churn and make the shared daily media charge transactional.

create table public.game_mutation_limits (
  owner_id uuid primary key references public.admin_profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null check(attempts>0),
  updated_at timestamptz not null default now()
);
alter table public.game_mutation_limits enable row level security;
revoke all on table public.game_mutation_limits from public,anon,authenticated;

create or replace function public.consume_game_mutation_attempt(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit constant integer:=200;v_window constant interval:=interval '1 day';v_owner uuid;v_row public.game_mutation_limits%rowtype;v_allowed boolean;v_retry integer;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  insert into public.game_mutation_limits(owner_id,window_started_at,attempts)values(v_owner,now(),1)
    on conflict(owner_id)do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.game_mutation_limits where owner_id=v_owner for update;
    if v_row.window_started_at<=now()-v_window then update public.game_mutation_limits set window_started_at=now(),attempts=1,updated_at=now() where owner_id=v_owner returning * into v_row;
    else update public.game_mutation_limits set attempts=attempts+1,updated_at=now() where owner_id=v_owner returning * into v_row;end if;
  end if;
  v_allowed:=v_row.attempts<=v_limit;v_retry:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer)end;
  return jsonb_build_object('allowed',v_allowed,'limit',v_limit,'remaining',greatest(0,v_limit-v_row.attempts),'retryAfterSeconds',v_retry);
end;$$;

create or replace function public.create_game_definition(p_admin_token_hash text,p_name text,p_questions jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_game uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  if char_length(btrim(p_name))not between 1 and 100 or p_name~'[[:cntrl:]]'then raise exception using errcode='22023',message='INVALID_GAME_NAME';end if;
  perform pg_advisory_xact_lock(hashtextextended('saved-game-project-quota',0));
  if(select count(*) from public.games)>=10000 then raise exception using errcode='P0001',message='PROJECT_GAME_CAPACITY_REACHED';end if;
  if(select count(*) from public.games where owner_id=v_owner)>=200 then raise exception using errcode='P0001',message='GAME_QUOTA_EXCEEDED';end if;
  if(select count(*) from public.games where owner_id=v_owner and deleted_at is null)>=50 then raise exception using errcode='P0001',message='GAME_QUOTA_EXCEEDED';end if;
  insert into public.games(owner_id,name)values(v_owner,btrim(p_name))returning id into v_game;
  perform public.replace_game_questions(v_owner,v_game,p_questions);
  return public.game_definition_json(v_game);
end;$$;

create or replace function public.register_game_media(
  p_admin_token_hash text,p_game_id uuid,p_storage_path text,p_silhouette_storage_path text,
  p_mime_type text,p_silhouette_mime_type text,p_byte_size integer
)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_id uuid;v_daily jsonb;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  if not exists(select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null)then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
  perform pg_advisory_xact_lock(hashtextextended('game-media-project-quota',0));
  if(select count(*) from public.game_media_assets)>=8000
    or coalesce((select sum(byte_size+65536::bigint)from public.game_media_assets),0)+p_byte_size+65536>4294967296 then raise exception using errcode='P0001',message='PROJECT_MEDIA_CAPACITY_REACHED';end if;
  if(select count(*) from public.game_media_assets where owner_id=v_owner)>=500
    or coalesce((select sum(byte_size+65536::bigint)from public.game_media_assets where owner_id=v_owner),0)+p_byte_size+65536>209715200 then raise exception using errcode='P0001',message='MEDIA_QUOTA_EXCEEDED';end if;
  if p_storage_path!~('^game-media/'||v_owner||'/[0-9a-f-]{36}\.(jpe?g|png|webp)$')
    or p_silhouette_storage_path!~('^game-media/'||v_owner||'/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$')
    or p_mime_type not in('image/jpeg','image/png','image/webp')or p_silhouette_mime_type not in('image/jpeg','image/png','image/webp')
    or p_byte_size not between 1 and 5242880 then raise exception using errcode='22023',message='INVALID_MEDIA';end if;
  v_daily:=public.reserve_project_media_bytes(p_byte_size);
  if not(v_daily->>'allowed')::boolean then raise exception using errcode='P0001',message='PROJECT_MEDIA_DAILY_LIMITED';end if;
  insert into public.game_media_assets(owner_id,game_id,storage_path,silhouette_storage_path,mime_type,silhouette_mime_type,byte_size,upload_state)
    values(v_owner,p_game_id,p_storage_path,p_silhouette_storage_path,p_mime_type,p_silhouette_mime_type,p_byte_size,'pending')returning id into v_id;
  return jsonb_build_object('id',v_id,'mimeType',p_mime_type,'byteSize',p_byte_size,'previewUrl','/api/games/'||p_game_id||'/media/'||v_id,
    'projectRemainingBytes',(v_daily->>'remainingBytes')::bigint);
end;$$;

create or replace function public.cleanup_stale_studio_state()
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare v_admin integer;v_sources integer;v_games integer;
begin
  delete from public.admin_profile_creation_limits where window_started_at<now()-interval '1 day';get diagnostics v_sources=row_count;
  delete from public.media_source_upload_limits where window_started_at<now()-interval '2 days';
  delete from public.media_source_byte_limits where window_started_at<now()-interval '3 days';
  delete from public.saved_session_creation_limits where window_started_at<now()-interval '1 day';
  delete from public.media_upload_limits where window_started_at<now()-interval '2 days';
  delete from public.game_mutation_limits where window_started_at<now()-interval '2 days';
  delete from public.games g where g.deleted_at<now()-interval '1 day'
    and not exists(select 1 from public.rooms r where r.game_id=g.id);
  get diagnostics v_games=row_count;
  delete from public.admin_profiles a where a.last_seen_at<now()-interval '30 days'
    and not exists(select 1 from public.games g where g.owner_id=a.id)
    and not exists(select 1 from public.game_media_assets m where m.owner_id=a.id);
  get diagnostics v_admin=row_count;
  return jsonb_build_object('deletedProfiles',v_admin,'deletedExpiredSources',v_sources,'deletedGames',v_games);
end;$$;

revoke all on function public.consume_game_mutation_attempt(text)from public,anon,authenticated;
grant execute on function public.consume_game_mutation_attempt(text)to service_role;
