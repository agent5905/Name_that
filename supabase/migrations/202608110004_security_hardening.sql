-- Forward-only hardening for saved-game uploads and media quota recovery.

create table public.media_upload_limits (
  owner_id uuid primary key references public.admin_profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0),
  updated_at timestamptz not null default now()
);

alter table public.media_upload_limits enable row level security;
revoke all on table public.media_upload_limits from public, anon, authenticated;

create or replace function public.consume_media_upload_attempt(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 100; v_window constant interval := interval '1 hour';
  v_owner uuid; v_row public.media_upload_limits%rowtype; v_allowed boolean; v_retry_after integer;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  insert into public.media_upload_limits(owner_id, window_started_at, attempts)
    values(v_owner, now(), 1) on conflict(owner_id) do nothing returning * into v_row;
  if not found then
    select * into strict v_row from public.media_upload_limits where owner_id=v_owner for update;
    if v_row.window_started_at <= now()-v_window then
      update public.media_upload_limits set window_started_at=now(), attempts=1, updated_at=now()
        where owner_id=v_owner returning * into v_row;
    else
      update public.media_upload_limits set attempts=attempts+1, updated_at=now()
        where owner_id=v_owner returning * into v_row;
    end if;
  end if;
  v_allowed := v_row.attempts <= v_limit;
  v_retry_after := case when v_allowed then 0 else
    greatest(1, ceil(extract(epoch from(v_row.window_started_at+v_window-now())))::integer) end;
  return jsonb_build_object('allowed',v_allowed,'limit',v_limit,
    'remaining',greatest(0,v_limit-v_row.attempts),'retryAfterSeconds',v_retry_after);
end; $$;

create or replace function public.register_game_media(
  p_admin_token_hash text, p_game_id uuid, p_storage_path text, p_silhouette_storage_path text,
  p_mime_type text, p_silhouette_mime_type text, p_byte_size integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_id uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if not exists (select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null) then
    raise exception using errcode='P0002', message='GAME_NOT_FOUND';
  end if;
  if (select count(*) from public.game_media_assets m where m.owner_id=v_owner and
        (m.created_at>now()-interval '24 hours' or exists(select 1 from public.game_questions q where q.media_asset_id=m.id)))>=500
     or coalesce((select sum(byte_size) from public.game_media_assets m where m.owner_id=v_owner and
        (m.created_at>now()-interval '24 hours' or exists(select 1 from public.game_questions q where q.media_asset_id=m.id))),0)+p_byte_size>209715200 then
    raise exception using errcode='P0001',message='MEDIA_QUOTA_EXCEEDED';
  end if;
  if p_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}\.(jpe?g|png|webp)$')
     or p_silhouette_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$')
     or p_mime_type not in ('image/jpeg','image/png','image/webp')
     or p_silhouette_mime_type not in ('image/jpeg','image/png','image/webp')
     or p_byte_size not between 1 and 5242880 then
    raise exception using errcode='22023',message='INVALID_MEDIA';
  end if;
  insert into public.game_media_assets(owner_id,game_id,storage_path,silhouette_storage_path,mime_type,silhouette_mime_type,byte_size)
    values(v_owner,p_game_id,p_storage_path,p_silhouette_storage_path,p_mime_type,p_silhouette_mime_type,p_byte_size)
    returning id into v_id;
  return jsonb_build_object('id',v_id,'mimeType',p_mime_type,'byteSize',p_byte_size,
    'previewUrl','/api/games/' || p_game_id || '/media/' || v_id);
end; $$;

revoke all on function public.consume_media_upload_attempt(text),
  public.register_game_media(text,uuid,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.consume_media_upload_attempt(text),
  public.register_game_media(text,uuid,text,text,text,text,integer)
  to service_role;
