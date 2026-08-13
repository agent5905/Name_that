-- pgcrypto is installed in the extensions schema. Saved-session functions use
-- a deliberately narrow search_path, so qualify the CSPRNG explicitly.

update public.session_questions q
set reveal_key=extensions.gen_random_bytes(32),
    reveal_iv=extensions.gen_random_bytes(12),
    reveal_aad='name-that:'||q.room_id||':'||q.id
from public.rooms r
where r.id=q.room_id and r.content_mode='saved' and q.reveal_media_path is not null
  and(q.reveal_key is null or q.reveal_iv is null or q.reveal_aad is null);

create or replace function public.create_game_session(p_admin_token_hash text,p_game_id uuid,p_code text,p_host_token_hash text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;g public.games%rowtype;existing public.rooms%rowtype;rid uuid;q record;sqid uuid;
begin owner:=public.admin_owner_id(p_admin_token_hash);if p_code!~'^[A-HJ-NP-Z2-9]{5}$'or p_host_token_hash!~'^[0-9a-f]{64}$'or p_idempotency_key is null then raise exception using message='INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));select*into existing from public.rooms where idempotency_key=p_idempotency_key;
 if found then if not exists(select 1 from public.games where id=p_game_id and owner_id=owner)or existing.game_id<>p_game_id or existing.host_token_hash<>decode(p_host_token_hash,'hex')then raise exception using message='IDEMPOTENCY_CONFLICT';end if;
 return jsonb_build_object('roomId',existing.id,'code',existing.code,'gameId',existing.game_id,'gameRevision',existing.game_revision,'gameName',existing.game_name);end if;
 select*into g from public.games where id=p_game_id and owner_id=owner and deleted_at is null for share;if not found then raise exception using message='GAME_NOT_FOUND';end if;
 if(select count(*)from public.rooms r join public.games x on x.id=r.game_id where x.owner_id=owner and r.updated_at>now()-interval'24 hours')>=50 or(select count(*)from public.rooms r join public.games x on x.id=r.game_id where x.owner_id=owner and r.phase<>'complete')>=10 then raise exception using message='SESSION_QUOTA_EXCEEDED';end if;
 if not exists(select 1 from public.game_questions where game_id=p_game_id)then raise exception using message='CONTENT_UNAVAILABLE';end if;
 if exists(select 1 from public.game_questions where game_id=p_game_id and(coalesce(mystery_media_asset_id,media_asset_id)is null or coalesce(reveal_media_asset_id,media_asset_id)is null))then raise exception using message='GAME_MEDIA_REQUIRED';end if;
 insert into public.rooms(code,host_token_hash,game_id,game_revision,game_name,idempotency_key,content_mode)values(p_code,decode(p_host_token_hash,'hex'),p_game_id,g.revision,g.name,p_idempotency_key,'saved')returning id into rid;
 for q in select x.id question_id,x.position,x.prompt,x.reveal_name,x.fun_fact,
   coalesce(m.mystery_storage_path,m.silhouette_storage_path) mystery_storage_path,
   coalesce(m.reveal_storage_path,m.storage_path) reveal_storage_path,
   coalesce(m.mystery_mime_type,m.silhouette_mime_type) mystery_mime_type,
   coalesce(m.reveal_mime_type,m.mime_type) reveal_mime_type
   from public.game_questions x join public.game_media_assets m on m.id=coalesce(x.mystery_media_asset_id,x.media_asset_id) where x.game_id=p_game_id order by x.position loop
  insert into public.session_questions(room_id,position,prompt,reveal_name,media_path,silhouette_media_path,media_mime_type,silhouette_mime_type,
   mystery_media_path,reveal_media_path,mystery_media_mime_type,reveal_media_mime_type,reveal_key,reveal_iv,reveal_aad,fun_fact)
  values(rid,q.position,q.prompt,q.reveal_name,q.reveal_storage_path,q.mystery_storage_path,q.reveal_mime_type,q.mystery_mime_type,
   q.mystery_storage_path,q.reveal_storage_path,q.mystery_mime_type,q.reveal_mime_type,extensions.gen_random_bytes(32),extensions.gen_random_bytes(12),'pending',q.fun_fact)returning id into sqid;
  update public.session_questions set reveal_aad='name-that:'||rid||':'||sqid where id=sqid;
  insert into public.session_choices(question_id,position,choice_text,is_correct)select sqid,c.position,c.choice_text,c.is_correct from public.game_choices c where c.question_id=q.question_id order by c.position;
 end loop;perform public.refresh_room_snapshot(rid);return jsonb_build_object('roomId',rid,'code',p_code,'gameId',g.id,'gameRevision',g.revision,'gameName',g.name);
exception when unique_violation then raise exception using message='CODE_COLLISION';end;$$;

create or replace function public.play_again_session(p_code text,p_host_token_hash text,p_new_code text,p_new_host_token_hash text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare old public.rooms%rowtype;existing public.rooms%rowtype;fresh uuid;q public.session_questions%rowtype;newq uuid;owner uuid;
begin if p_new_code!~'^[A-HJ-NP-Z2-9]{5}$'or p_new_host_token_hash!~'^[0-9a-f]{64}$'or p_idempotency_key is null then raise exception using message='INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));select*into old from public.rooms where code=p_code for update;
 if not found then raise exception using message='ROOM_NOT_FOUND';end if;if old.host_token_hash<>decode(p_host_token_hash,'hex')then raise exception using message='HOST_UNAUTHORIZED';end if;
 if old.phase<>'complete'then raise exception using message='ILLEGAL_TRANSITION';end if;if old.game_id is null then raise exception using message='PLAY_AGAIN_UNAVAILABLE';end if;
 select owner_id into owner from public.games where id=old.game_id;perform 1 from public.admin_profiles where id=owner for update;
 select*into existing from public.rooms where source_room_id=old.id and idempotency_key=p_idempotency_key;if found then
  if existing.host_token_hash<>decode(p_new_host_token_hash,'hex')then raise exception using message='IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('roomId',existing.id,'code',existing.code,'gameId',existing.game_id,'gameRevision',existing.game_revision,'gameName',existing.game_name);end if;
 if(select count(*)from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=owner and r.updated_at>now()-interval'24 hours')>=50 or(select count(*)from public.rooms r join public.games g on g.id=r.game_id where g.owner_id=owner and r.phase<>'complete')>=10 then raise exception using message='SESSION_QUOTA_EXCEEDED';end if;
 insert into public.rooms(code,host_token_hash,game_id,game_revision,game_name,source_room_id,idempotency_key,content_mode)values(p_new_code,decode(p_new_host_token_hash,'hex'),old.game_id,old.game_revision,old.game_name,old.id,p_idempotency_key,'saved')returning id into fresh;
 for q in select*from public.session_questions where room_id=old.id order by position loop
  insert into public.session_questions(room_id,position,prompt,reveal_name,media_path,silhouette_media_path,media_mime_type,silhouette_mime_type,
   mystery_media_path,reveal_media_path,mystery_media_mime_type,reveal_media_mime_type,reveal_key,reveal_iv,reveal_aad,fun_fact)
  values(fresh,q.position,q.prompt,q.reveal_name,q.media_path,q.silhouette_media_path,q.media_mime_type,q.silhouette_mime_type,
   q.mystery_media_path,q.reveal_media_path,q.mystery_media_mime_type,q.reveal_media_mime_type,extensions.gen_random_bytes(32),extensions.gen_random_bytes(12),'pending',q.fun_fact)returning id into newq;
  update public.session_questions set reveal_aad='name-that:'||fresh||':'||newq where id=newq;
  insert into public.session_choices(question_id,position,choice_text,is_correct)select newq,position,choice_text,is_correct from public.session_choices where question_id=q.id order by position;
 end loop;perform public.refresh_room_snapshot(fresh);return jsonb_build_object('roomId',fresh,'code',p_new_code,'gameId',old.game_id,'gameRevision',old.game_revision,'gameName',old.game_name);
exception when unique_violation then raise exception using message='CODE_COLLISION';end;$$;

revoke all on function public.create_game_session(text,uuid,text,text,uuid),public.play_again_session(text,text,text,text,uuid)from public,anon,authenticated;
grant execute on function public.create_game_session(text,uuid,text,text,uuid),public.play_again_session(text,text,text,text,uuid)to service_role;
