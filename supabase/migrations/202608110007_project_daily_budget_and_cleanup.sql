-- Bound aggregate cross-source growth and prune ephemeral abuse-control state.

create table public.project_media_daily_budget (
  singleton boolean primary key default true check (singleton),
  window_started_at timestamptz not null,
  reserved_bytes bigint not null check (reserved_bytes>0),
  updated_at timestamptz not null default now()
);
alter table public.project_media_daily_budget enable row level security;
revoke all on table public.project_media_daily_budget from public,anon,authenticated;

create or replace function public.reserve_project_media_bytes(p_byte_size integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit constant bigint:=536870912;v_window constant interval:=interval '1 day';v_row public.project_media_daily_budget%rowtype;v_allowed boolean;v_retry integer;
begin
  if p_byte_size not between 1 and 5242880 then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('game-media-project-daily-budget',0));
  insert into public.project_media_daily_budget(singleton,window_started_at,reserved_bytes)values(true,now(),p_byte_size)
    on conflict(singleton)do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.project_media_daily_budget where singleton=true for update;
    if v_row.window_started_at<=now()-v_window then update public.project_media_daily_budget set window_started_at=now(),reserved_bytes=p_byte_size,updated_at=now() where singleton=true returning * into v_row;
    else update public.project_media_daily_budget set reserved_bytes=reserved_bytes+p_byte_size,updated_at=now() where singleton=true returning * into v_row;end if;
  end if;
  v_allowed:=v_row.reserved_bytes<=v_limit;v_retry:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer)end;
  return jsonb_build_object('allowed',v_allowed,'limitBytes',v_limit,'remainingBytes',greatest(0,v_limit-v_row.reserved_bytes),'retryAfterSeconds',v_retry);
end;$$;

create or replace function public.cleanup_stale_studio_state()
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare v_admin integer;v_sources integer;
begin
  delete from public.admin_profile_creation_limits where window_started_at<now()-interval '1 day';get diagnostics v_sources=row_count;
  delete from public.media_source_upload_limits where window_started_at<now()-interval '2 days';
  delete from public.media_source_byte_limits where window_started_at<now()-interval '3 days';
  delete from public.saved_session_creation_limits where window_started_at<now()-interval '1 day';
  delete from public.media_upload_limits where window_started_at<now()-interval '2 days';
  delete from public.admin_profiles a where a.last_seen_at<now()-interval '30 days'
    and not exists(select 1 from public.games g where g.owner_id=a.id)
    and not exists(select 1 from public.game_media_assets m where m.owner_id=a.id);
  get diagnostics v_admin=row_count;
  return jsonb_build_object('deletedProfiles',v_admin,'deletedExpiredSources',v_sources);
end;$$;

create or replace function public.register_game_media(
  p_admin_token_hash text,p_game_id uuid,p_storage_path text,p_silhouette_storage_path text,
  p_mime_type text,p_silhouette_mime_type text,p_byte_size integer
)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_id uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  if not exists(select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null)then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
  perform pg_advisory_xact_lock(hashtextextended('game-media-project-quota',0));
  -- Public admission stops at 4 GiB/8k assets, reserving at least 1 GiB/2k
  -- objects for operational recovery below the physical 5 GiB/10k ceiling.
  if(select count(*) from public.game_media_assets)>=8000
    or coalesce((select sum(byte_size+65536::bigint) from public.game_media_assets),0)+p_byte_size+65536>4294967296 then raise exception using errcode='P0001',message='PROJECT_MEDIA_CAPACITY_REACHED';end if;
  if(select count(*) from public.game_media_assets where owner_id=v_owner)>=500
    or coalesce((select sum(byte_size+65536::bigint) from public.game_media_assets where owner_id=v_owner),0)+p_byte_size+65536>209715200 then raise exception using errcode='P0001',message='MEDIA_QUOTA_EXCEEDED';end if;
  if p_storage_path!~('^game-media/'||v_owner||'/[0-9a-f-]{36}\.(jpe?g|png|webp)$')
    or p_silhouette_storage_path!~('^game-media/'||v_owner||'/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$')
    or p_mime_type not in('image/jpeg','image/png','image/webp')or p_silhouette_mime_type not in('image/jpeg','image/png','image/webp')
    or p_byte_size not between 1 and 5242880 then raise exception using errcode='22023',message='INVALID_MEDIA';end if;
  insert into public.game_media_assets(owner_id,game_id,storage_path,silhouette_storage_path,mime_type,silhouette_mime_type,byte_size,upload_state)
    values(v_owner,p_game_id,p_storage_path,p_silhouette_storage_path,p_mime_type,p_silhouette_mime_type,p_byte_size,'pending')returning id into v_id;
  return jsonb_build_object('id',v_id,'mimeType',p_mime_type,'byteSize',p_byte_size,'previewUrl','/api/games/'||p_game_id||'/media/'||v_id);
end;$$;

revoke all on function public.reserve_project_media_bytes(integer),public.cleanup_stale_studio_state() from public,anon,authenticated;
grant execute on function public.reserve_project_media_bytes(integer),public.cleanup_stale_studio_state() to service_role;
