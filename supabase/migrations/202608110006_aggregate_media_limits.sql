-- Prevent owner rotation from multiplying storage and CPU allowances.

create table public.admin_profile_creation_limits (
  source_hash bytea primary key check (octet_length(source_hash)=32),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts>0),
  updated_at timestamptz not null default now()
);
create table public.media_source_upload_limits (
  source_hash bytea primary key check (octet_length(source_hash)=32),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts>0),
  updated_at timestamptz not null default now()
);
create table public.media_source_byte_limits (
  source_hash bytea primary key check (octet_length(source_hash)=32),
  window_started_at timestamptz not null,
  reserved_bytes bigint not null check (reserved_bytes>0),
  updated_at timestamptz not null default now()
);
alter table public.admin_profile_creation_limits enable row level security;
alter table public.media_source_upload_limits enable row level security;
alter table public.media_source_byte_limits enable row level security;
revoke all on table public.admin_profile_creation_limits,public.media_source_upload_limits,
  public.media_source_byte_limits from public,anon,authenticated;

create or replace function public.consume_admin_profile_attempt(p_source_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit constant integer:=5;v_window constant interval:=interval '15 minutes';v_row public.admin_profile_creation_limits%rowtype;v_allowed boolean;v_retry integer;
begin
  if p_source_hash!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  insert into public.admin_profile_creation_limits(source_hash,window_started_at,attempts)values(decode(p_source_hash,'hex'),now(),1)
    on conflict(source_hash)do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.admin_profile_creation_limits where source_hash=decode(p_source_hash,'hex') for update;
    if v_row.window_started_at<=now()-v_window then update public.admin_profile_creation_limits set window_started_at=now(),attempts=1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;
    else update public.admin_profile_creation_limits set attempts=attempts+1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;end if;
  end if;
  v_allowed:=v_row.attempts<=v_limit;v_retry:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer)end;
  return jsonb_build_object('allowed',v_allowed,'limit',v_limit,'remaining',greatest(0,v_limit-v_row.attempts),'retryAfterSeconds',v_retry);
end;$$;

create or replace function public.consume_media_source_attempt(p_source_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit constant integer:=30;v_window constant interval:=interval '1 hour';v_row public.media_source_upload_limits%rowtype;v_allowed boolean;v_retry integer;
begin
  if p_source_hash!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  insert into public.media_source_upload_limits(source_hash,window_started_at,attempts)values(decode(p_source_hash,'hex'),now(),1)
    on conflict(source_hash)do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.media_source_upload_limits where source_hash=decode(p_source_hash,'hex') for update;
    if v_row.window_started_at<=now()-v_window then update public.media_source_upload_limits set window_started_at=now(),attempts=1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;
    else update public.media_source_upload_limits set attempts=attempts+1,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;end if;
  end if;
  v_allowed:=v_row.attempts<=v_limit;v_retry:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer)end;
  return jsonb_build_object('allowed',v_allowed,'limit',v_limit,'remaining',greatest(0,v_limit-v_row.attempts),'retryAfterSeconds',v_retry);
end;$$;

create or replace function public.reserve_media_source_bytes(p_source_hash text,p_byte_size integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_limit constant bigint:=262144000;v_window constant interval:=interval '1 day';v_row public.media_source_byte_limits%rowtype;v_allowed boolean;v_retry integer;
begin
  if p_source_hash!~'^[0-9a-f]{64}$' or p_byte_size not between 1 and 5242880 then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  insert into public.media_source_byte_limits(source_hash,window_started_at,reserved_bytes)values(decode(p_source_hash,'hex'),now(),p_byte_size)
    on conflict(source_hash)do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.media_source_byte_limits where source_hash=decode(p_source_hash,'hex') for update;
    if v_row.window_started_at<=now()-v_window then update public.media_source_byte_limits set window_started_at=now(),reserved_bytes=p_byte_size,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;
    else update public.media_source_byte_limits set reserved_bytes=reserved_bytes+p_byte_size,updated_at=now() where source_hash=v_row.source_hash returning * into v_row;end if;
  end if;
  v_allowed:=v_row.reserved_bytes<=v_limit;v_retry:=case when v_allowed then 0 else greatest(1,ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer)end;
  return jsonb_build_object('allowed',v_allowed,'limitBytes',v_limit,'remainingBytes',greatest(0,v_limit-v_row.reserved_bytes),'retryAfterSeconds',v_retry);
end;$$;

create or replace function public.register_game_media(
  p_admin_token_hash text,p_game_id uuid,p_storage_path text,p_silhouette_storage_path text,
  p_mime_type text,p_silhouette_mime_type text,p_byte_size integer
)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid;v_id uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  if not exists(select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null)then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
  -- One lock serializes the physical project ceiling across rotating owners.
  perform pg_advisory_xact_lock(hashtextextended('game-media-project-quota',0));
  if(select count(*) from public.game_media_assets)>=10000
    or coalesce((select sum(byte_size+65536::bigint) from public.game_media_assets),0)+p_byte_size+65536>5368709120 then raise exception using errcode='P0001',message='PROJECT_MEDIA_CAPACITY_REACHED';end if;
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

revoke all on function public.consume_admin_profile_attempt(text),public.consume_media_source_attempt(text),
  public.reserve_media_source_bytes(text,integer) from public,anon,authenticated;
grant execute on function public.consume_admin_profile_attempt(text),public.consume_media_source_attempt(text),
  public.reserve_media_source_bytes(text,integer) to service_role;
