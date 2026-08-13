-- Account for every upload before Storage writes and reclaim only media that
-- cannot affect either a live definition or an immutable retained session.

alter table public.game_media_assets
  add column upload_state text not null default 'ready'
    check (upload_state in ('pending','ready','deleting')),
  add column gc_claimed_at timestamptz;

create or replace function public.register_game_media(
  p_admin_token_hash text, p_game_id uuid, p_storage_path text, p_silhouette_storage_path text,
  p_mime_type text, p_silhouette_mime_type text, p_byte_size integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_id uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  if not exists (select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null) then
    raise exception using errcode='P0002',message='GAME_NOT_FOUND';
  end if;
  -- Count every reservation until physical object deletion has succeeded.
  if (select count(*) from public.game_media_assets where owner_id=v_owner)>=500
     or coalesce((select sum(byte_size) from public.game_media_assets where owner_id=v_owner),0)+p_byte_size>209715200 then
    raise exception using errcode='P0001',message='MEDIA_QUOTA_EXCEEDED';
  end if;
  if p_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}\.(jpe?g|png|webp)$')
     or p_silhouette_storage_path !~ ('^game-media/' || v_owner || '/[0-9a-f-]{36}-silhouette\.(jpe?g|png|webp)$')
     or p_mime_type not in ('image/jpeg','image/png','image/webp')
     or p_silhouette_mime_type not in ('image/jpeg','image/png','image/webp')
     or p_byte_size not between 1 and 5242880 then
    raise exception using errcode='22023',message='INVALID_MEDIA';
  end if;
  insert into public.game_media_assets(owner_id,game_id,storage_path,silhouette_storage_path,mime_type,silhouette_mime_type,byte_size,upload_state)
    values(v_owner,p_game_id,p_storage_path,p_silhouette_storage_path,p_mime_type,p_silhouette_mime_type,p_byte_size,'pending')
    returning id into v_id;
  return jsonb_build_object('id',v_id,'mimeType',p_mime_type,'byteSize',p_byte_size,
    'previewUrl','/api/games/' || p_game_id || '/media/' || v_id);
end; $$;

create or replace function public.complete_game_media(
  p_admin_token_hash text, p_game_id uuid, p_media_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_media public.game_media_assets%rowtype;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  update public.game_media_assets set upload_state='ready',gc_claimed_at=null
    where id=p_media_id and game_id=p_game_id and owner_id=v_owner and upload_state='pending'
    returning * into v_media;
  if not found then raise exception using errcode='P0002',message='MEDIA_NOT_FOUND'; end if;
  return jsonb_build_object('id',v_media.id,'mimeType',v_media.mime_type,'byteSize',v_media.byte_size,
    'previewUrl','/api/games/' || p_game_id || '/media/' || v_media.id);
end; $$;

create or replace function public.claim_game_media_gc(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_result jsonb;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  with candidates as (
    select m.id from public.game_media_assets m
    left join public.games g on g.id=m.game_id
    where m.owner_id=v_owner
      and not exists (
        select 1 from public.game_questions q join public.games active on active.id=q.game_id
        where q.media_asset_id=m.id and active.deleted_at is null
      )
      and not exists (
        select 1 from public.session_questions sq
        where sq.media_path=m.storage_path or sq.silhouette_media_path=m.silhouette_storage_path
      )
      and (
        (m.upload_state='pending' and m.created_at<now()-interval '1 hour')
        or (m.upload_state='ready' and (m.created_at<now()-interval '24 hours' or g.deleted_at is not null))
        or (m.upload_state='deleting' and m.gc_claimed_at<now()-interval '10 minutes')
      )
    order by m.created_at
    for update of m skip locked limit 20
  ), claimed as (
    update public.game_media_assets m set upload_state='deleting',gc_claimed_at=now()
      from candidates c where m.id=c.id
      returning m.id,m.storage_path,m.silhouette_storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'storagePath',storage_path,
    'silhouetteStoragePath',silhouette_storage_path)),'[]'::jsonb) into v_result from claimed;
  return v_result;
end; $$;

create or replace function public.finalize_game_media_gc(
  p_admin_token_hash text, p_media_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_deleted integer;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  with removed as (
    delete from public.game_media_assets m
    where m.owner_id=v_owner and m.upload_state='deleting' and m.id=any(p_media_ids)
      and not exists (
        select 1 from public.game_questions q join public.games active on active.id=q.game_id
        where q.media_asset_id=m.id and active.deleted_at is null
      )
      and not exists (
        select 1 from public.session_questions sq
        where sq.media_path=m.storage_path or sq.silhouette_media_path=m.silhouette_storage_path
      ) returning 1
  ) select count(*) into v_deleted from removed;
  return jsonb_build_object('deletedAssets',v_deleted);
end; $$;

create or replace function public.owner_game_media_paths(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  v_owner := public.admin_owner_id(p_admin_token_hash);
  return jsonb_build_object('ownerId',v_owner,'paths',coalesce((select jsonb_agg(path) from (
    select storage_path as path from public.game_media_assets where owner_id=v_owner
    union all select silhouette_storage_path from public.game_media_assets where owner_id=v_owner
  ) paths),'[]'::jsonb));
end; $$;

create or replace function public.validate_game_questions(
  p_owner_id uuid, p_game_id uuid, p_questions jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_question jsonb; v_choice jsonb; v_q_count integer; v_c_count integer; v_correct integer; v_media uuid;
begin
  if jsonb_typeof(p_questions)<>'array' then raise exception using errcode='22023',message='INVALID_GAME_DEFINITION'; end if;
  v_q_count:=jsonb_array_length(p_questions);
  if v_q_count<0 or v_q_count>100 then raise exception using errcode='22023',message='INVALID_QUESTION_COUNT'; end if;
  for v_question in select value from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(v_question)<>'object'
      or char_length(btrim(coalesce(v_question->>'prompt',''))) not between 1 and 160
      or char_length(btrim(coalesce(v_question->>'revealName',''))) not between 1 and 100
      or coalesce(v_question->>'prompt','')~'[[:cntrl:]]'
      or coalesce(v_question->>'revealName','')~'[[:cntrl:]]'
      or jsonb_typeof(v_question->'choices')<>'array' then
      raise exception using errcode='22023',message='INVALID_QUESTION';
    end if;
    v_c_count:=jsonb_array_length(v_question->'choices');
    if v_c_count<2 or v_c_count>10 then raise exception using errcode='22023',message='INVALID_CHOICE_COUNT'; end if;
    v_correct:=0;
    for v_choice in select value from jsonb_array_elements(v_question->'choices') loop
      if jsonb_typeof(v_choice)<>'object'
        or char_length(btrim(coalesce(v_choice->>'text',''))) not between 1 and 100
        or coalesce(v_choice->>'text','')~'[[:cntrl:]]'
        or jsonb_typeof(v_choice->'isCorrect')<>'boolean' then
        raise exception using errcode='22023',message='INVALID_CHOICE';
      end if;
      if (v_choice->>'isCorrect')::boolean then v_correct:=v_correct+1; end if;
    end loop;
    if v_correct<>1 then raise exception using errcode='22023',message='INVALID_CORRECT_CHOICE_COUNT'; end if;
    if v_question?'mediaAssetId' and v_question->>'mediaAssetId' is not null then
      begin v_media:=(v_question->>'mediaAssetId')::uuid;
      exception when invalid_text_representation then raise exception using errcode='22023',message='INVALID_MEDIA_ASSET'; end;
      if not exists(select 1 from public.game_media_assets where id=v_media and game_id=p_game_id
        and owner_id=p_owner_id and upload_state='ready') then
        raise exception using errcode='42501',message='MEDIA_NOT_OWNED';
      end if;
    end if;
  end loop;
end; $$;

create or replace function public.get_game_media(
  p_admin_token_hash text, p_game_id uuid, p_media_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_media public.game_media_assets%rowtype;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  select * into v_media from public.game_media_assets where id=p_media_id and game_id=p_game_id
    and owner_id=v_owner and upload_state='ready';
  if not found then raise exception using errcode='P0002',message='MEDIA_NOT_FOUND'; end if;
  return jsonb_build_object('storagePath',v_media.storage_path,'silhouetteStoragePath',v_media.silhouette_storage_path,
    'mimeType',v_media.mime_type,'byteSize',v_media.byte_size);
end; $$;

create or replace function public.delete_game_definition(p_admin_token_hash text,p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid;
begin
  v_owner:=public.admin_owner_id(p_admin_token_hash);
  if not exists(select 1 from public.games where id=p_game_id and owner_id=v_owner and deleted_at is null for update) then
    raise exception using errcode='P0002',message='GAME_NOT_FOUND';
  end if;
  update public.games set deleted_at=now(),updated_at=now(),revision=revision+1
    where id=p_game_id and owner_id=v_owner;
  -- Immutable sessions already hold their own content and paths. Removing the
  -- definition rows releases only editor references; GC still checks sessions.
  delete from public.game_questions where game_id=p_game_id;
  return jsonb_build_object('storagePaths','[]'::jsonb);
end; $$;

revoke all on function public.complete_game_media(text,uuid,uuid),
  public.claim_game_media_gc(text), public.finalize_game_media_gc(text,uuid[]),
  public.owner_game_media_paths(text) from public,anon,authenticated;
grant execute on function public.complete_game_media(text,uuid,uuid),
  public.claim_game_media_gc(text), public.finalize_game_media_gc(text,uuid[]),
  public.owner_game_media_paths(text) to service_role;
