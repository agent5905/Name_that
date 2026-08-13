-- Explicit host-authored mystery/reveal pairs, optional reveal copy, and
-- session-unique encrypted reveal preload metadata. Existing rows/sessions retain
-- their legacy original/silhouette paths and continue to resolve unchanged.

alter table public.game_media_assets drop constraint if exists game_media_assets_storage_path_check;
alter table public.game_media_assets drop constraint if exists game_media_assets_silhouette_storage_path_check;
alter table public.game_media_assets drop constraint if exists game_media_assets_byte_size_check;
alter table public.game_media_assets add constraint game_media_assets_storage_path_check check(
 storage_path~'^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}(-(reveal))?\.(jpe?g|png|webp)$');
alter table public.game_media_assets add constraint game_media_assets_silhouette_storage_path_check check(
 silhouette_storage_path~'^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}(-(silhouette|mystery))?\.(jpe?g|png|webp)$');
alter table public.game_media_assets add constraint game_media_assets_byte_size_check check(byte_size between 1 and 10485760);

alter table public.game_media_assets
  add column mystery_storage_path text,
  add column reveal_storage_path text,
  add column mystery_mime_type text,
  add column reveal_mime_type text,
  add column mystery_byte_size integer,
  add column reveal_byte_size integer;

alter table public.game_media_assets add constraint explicit_media_pair_consistent check (
  (mystery_storage_path is null and reveal_storage_path is null
    and mystery_mime_type is null and reveal_mime_type is null and mystery_byte_size is null
    and reveal_byte_size is null)
  or
  (mystery_storage_path ~ '^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}-mystery\.png$'
    and reveal_storage_path ~ '^game-media/[0-9a-f-]{36}/[0-9a-f-]{36}-reveal\.png$'
    and mystery_mime_type='image/png' and reveal_mime_type='image/png'
    and mystery_byte_size between 1 and 5242880 and reveal_byte_size between 1 and 5242880)
);
create unique index game_media_mystery_path_idx on public.game_media_assets(mystery_storage_path) where mystery_storage_path is not null;
create unique index game_media_reveal_path_idx on public.game_media_assets(reveal_storage_path) where reveal_storage_path is not null;

alter table public.game_questions
  add column mystery_media_asset_id uuid references public.game_media_assets(id) on delete set null,
  add column reveal_media_asset_id uuid references public.game_media_assets(id) on delete set null,
  add column fun_fact text check (fun_fact is null or (char_length(fun_fact) between 1 and 500 and fun_fact !~ '[[:cntrl:]]'));
update public.game_questions set mystery_media_asset_id=media_asset_id,reveal_media_asset_id=media_asset_id
  where media_asset_id is not null;
alter table public.game_questions add constraint question_media_pair_same_asset check (
  (mystery_media_asset_id is null and reveal_media_asset_id is null)
  or (mystery_media_asset_id is not null and mystery_media_asset_id=reveal_media_asset_id)
);

alter table public.session_questions
  add column mystery_media_path text,
  add column reveal_media_path text,
  add column mystery_media_mime_type text,
  add column reveal_media_mime_type text,
  add column reveal_key bytea,
  add column reveal_iv bytea,
  add column reveal_aad text,
  add column fun_fact text check (fun_fact is null or char_length(fun_fact) between 1 and 500);
update public.session_questions set mystery_media_path=silhouette_media_path,reveal_media_path=media_path,
  mystery_media_mime_type=silhouette_mime_type,reveal_media_mime_type=media_mime_type;
update public.session_questions q set reveal_key=extensions.gen_random_bytes(32),reveal_iv=extensions.gen_random_bytes(12),
 reveal_aad='name-that:'||q.room_id||':'||q.id where q.reveal_media_path is not null;

create or replace function public.reserve_media_source_bytes(p_source_hash text,p_byte_size integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare lim constant bigint:=262144000;win constant interval:=interval'1 day';r public.media_source_byte_limits%rowtype;allowed boolean;retry integer;
begin if p_source_hash!~'^[0-9a-f]{64}$'or p_byte_size not between 1 and 10485760 then raise exception using message='INVALID_INPUT';end if;
 insert into public.media_source_byte_limits(source_hash,window_started_at,reserved_bytes)values(decode(p_source_hash,'hex'),now(),p_byte_size)on conflict(source_hash)do nothing returning*into r;
 if not found then select*into strict r from public.media_source_byte_limits where source_hash=decode(p_source_hash,'hex')for update;
  if r.window_started_at<=now()-win then update public.media_source_byte_limits set window_started_at=now(),reserved_bytes=p_byte_size,updated_at=now()where source_hash=r.source_hash returning*into r;
  else update public.media_source_byte_limits set reserved_bytes=reserved_bytes+p_byte_size,updated_at=now()where source_hash=r.source_hash returning*into r;end if;end if;
 allowed:=r.reserved_bytes<=lim;retry:=case when allowed then 0 else greatest(1,ceil(extract(epoch from(r.window_started_at+win-now())))::integer)end;
 return jsonb_build_object('allowed',allowed,'limitBytes',lim,'remainingBytes',greatest(0,lim-r.reserved_bytes),'retryAfterSeconds',retry);end;$$;

create or replace function public.reserve_project_media_bytes(p_byte_size integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare lim constant bigint:=536870912;win constant interval:=interval'1 day';r public.project_media_daily_budget%rowtype;allowed boolean;retry integer;
begin if p_byte_size not between 1 and 10485760 then raise exception using message='INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended('game-media-project-daily-budget',0));
 insert into public.project_media_daily_budget(singleton,window_started_at,reserved_bytes)values(true,now(),p_byte_size)on conflict(singleton)do nothing returning*into r;
 if not found then select*into strict r from public.project_media_daily_budget where singleton=true for update;
  if r.window_started_at<=now()-win then update public.project_media_daily_budget set window_started_at=now(),reserved_bytes=p_byte_size,updated_at=now()where singleton=true returning*into r;
  else update public.project_media_daily_budget set reserved_bytes=reserved_bytes+p_byte_size,updated_at=now()where singleton=true returning*into r;end if;end if;
 allowed:=r.reserved_bytes<=lim;retry:=case when allowed then 0 else greatest(1,ceil(extract(epoch from(r.window_started_at+win-now())))::integer)end;
 return jsonb_build_object('allowed',allowed,'limitBytes',lim,'remainingBytes',greatest(0,lim-r.reserved_bytes),'retryAfterSeconds',retry);end;$$;

alter table public.room_snapshots
  add column mystery_image_url text,
  add column preload_assets jsonb not null default '[]'::jsonb check (jsonb_typeof(preload_assets)='array');

create or replace function public.decorate_explicit_snapshot()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms%rowtype;q public.session_questions%rowtype;base integer;last integer;items jsonb:='[]'::jsonb;
begin
 select*into r from public.rooms where code=new.room_code;
 if r.content_mode<>'saved'then return new;end if;base:=coalesce(r.current_round,0);select max(position)into last from public.session_questions where room_id=r.id;
 select*into q from public.session_questions where room_id=r.id and position=base;
 if found then
  new.mystery_image_url:='/api/rooms/'||r.code||'/mystery';new.silhouette_url:=new.mystery_image_url;
  items:=items||jsonb_build_array(jsonb_build_object('key',r.code||':'||base||':mystery','kind','mystery','roundIndex',base,'url','/api/rooms/'||r.code||'/mystery-preload?round='||base||'&asset='||q.id));
  if q.reveal_media_path is not null and q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null then items:=items||jsonb_build_array(jsonb_build_object('key',r.code||':'||base||':reveal','kind','reveal-encrypted','roundIndex',base,'url','/api/rooms/'||r.code||'/reveal-preload?round='||base||'&asset='||q.id));end if;
  if new.revealed_employee is not null then
   if q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null then new.revealed_employee:=jsonb_set(new.revealed_employee,'{mediaKey}',to_jsonb(r.code||':'||base||':reveal'));end if;
   if q.fun_fact is not null then new.revealed_employee:=jsonb_set(new.revealed_employee,'{funFact}',to_jsonb(q.fun_fact));end if;
  end if;
 end if;
 if base<last then
  select*into q from public.session_questions where room_id=r.id and position=base+1;
  items:=items||jsonb_build_array(jsonb_build_object('key',r.code||':'||(base+1)||':mystery','kind','mystery','roundIndex',base+1,'url','/api/rooms/'||r.code||'/mystery-preload?round='||(base+1)||'&asset='||q.id));
  if q.reveal_media_path is not null and q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null then items:=items||jsonb_build_array(jsonb_build_object('key',r.code||':'||(base+1)||':reveal','kind','reveal-encrypted','roundIndex',base+1,'url','/api/rooms/'||r.code||'/reveal-preload?round='||(base+1)||'&asset='||q.id));end if;
 end if;new.preload_assets:=items;return new;
end;$$;
drop trigger if exists decorate_explicit_snapshot on public.room_snapshots;
create trigger decorate_explicit_snapshot before insert or update on public.room_snapshots for each row execute function public.decorate_explicit_snapshot();

create or replace function public.validate_game_questions(p_owner_id uuid,p_game_id uuid,p_questions jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare q jsonb;c jsonb;asset uuid;qc integer;cc integer;correct integer;mystery text;reveal text;fact text;
begin
  if jsonb_typeof(p_questions)<>'array' then raise exception using errcode='22023',message='INVALID_GAME_DEFINITION';end if;
  qc:=jsonb_array_length(p_questions);if qc>100 then raise exception using errcode='22023',message='INVALID_QUESTION_COUNT';end if;
  for q in select value from jsonb_array_elements(p_questions) loop
    fact:=nullif(btrim(coalesce(q->>'funFact','')),'');mystery:=q->>'mysteryMediaAssetId';reveal:=q->>'revealMediaAssetId';
    if jsonb_typeof(q)<>'object' or char_length(btrim(coalesce(q->>'prompt',''))) not between 1 and 160
      or char_length(btrim(coalesce(q->>'revealName',''))) not between 1 and 100
      or coalesce(q->>'prompt','')~'[[:cntrl:]]' or coalesce(q->>'revealName','')~'[[:cntrl:]]'
      or (fact is not null and (char_length(fact)>500 or fact~'[[:cntrl:]]')) or jsonb_typeof(q->'choices')<>'array'
      then raise exception using errcode='22023',message='INVALID_QUESTION';end if;
    cc:=jsonb_array_length(q->'choices');if cc<2 or cc>10 then raise exception using errcode='22023',message='INVALID_CHOICE_COUNT';end if;
    correct:=0;for c in select value from jsonb_array_elements(q->'choices') loop
      if jsonb_typeof(c)<>'object' or char_length(btrim(coalesce(c->>'text',''))) not between 1 and 100
        or coalesce(c->>'text','')~'[[:cntrl:]]' or jsonb_typeof(c->'isCorrect')<>'boolean'
        then raise exception using errcode='22023',message='INVALID_CHOICE';end if;
      if(c->>'isCorrect')::boolean then correct:=correct+1;end if;
    end loop;if correct<>1 then raise exception using errcode='22023',message='INVALID_CORRECT_CHOICE_COUNT';end if;
    if (mystery is null)<>(reveal is null) or mystery is distinct from reveal then raise exception using errcode='22023',message='INVALID_MEDIA_PAIR';end if;
    if mystery is not null then
      begin asset:=mystery::uuid;exception when invalid_text_representation then raise exception using errcode='22023',message='INVALID_MEDIA_ASSET';end;
      if not exists(select 1 from public.game_media_assets where id=asset and game_id=p_game_id and owner_id=p_owner_id
        and upload_state='ready' and coalesce(mystery_storage_path,silhouette_storage_path)is not null and coalesce(reveal_storage_path,storage_path)is not null)
        then raise exception using errcode='42501',message='MEDIA_NOT_OWNED';end if;
    end if;
  end loop;
end;$$;

create or replace function public.replace_game_questions(p_owner_id uuid,p_game_id uuid,p_questions jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare q jsonb;c jsonb;qid uuid;asset uuid;qpos integer:=0;cpos integer;
begin
  perform public.validate_game_questions(p_owner_id,p_game_id,p_questions);delete from public.game_questions where game_id=p_game_id;
  for q in select value from jsonb_array_elements(p_questions) loop
    asset:=case when q->>'mysteryMediaAssetId' is null then null else(q->>'mysteryMediaAssetId')::uuid end;
    insert into public.game_questions(game_id,position,prompt,reveal_name,media_asset_id,mystery_media_asset_id,reveal_media_asset_id,fun_fact)
      values(p_game_id,qpos,btrim(q->>'prompt'),btrim(q->>'revealName'),asset,asset,asset,nullif(btrim(coalesce(q->>'funFact','')),'')) returning id into qid;
    cpos:=0;for c in select value from jsonb_array_elements(q->'choices') loop
      insert into public.game_choices(question_id,position,choice_text,is_correct)values(qid,cpos,btrim(c->>'text'),(c->>'isCorrect')::boolean);cpos:=cpos+1;
    end loop;qpos:=qpos+1;
  end loop;
end;$$;

create or replace function public.game_definition_json(p_game_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp stable as $$
select jsonb_build_object('id',g.id,'name',g.name,'revision',g.revision,'createdAt',g.created_at,'updatedAt',g.updated_at,
 'questions',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'position',q.position,'prompt',q.prompt,'revealName',q.reveal_name,
 'funFact',q.fun_fact,'mysteryMediaAssetId',q.mystery_media_asset_id,'revealMediaAssetId',q.reveal_media_asset_id,
 'mysteryMediaPreviewUrl',case when q.mystery_media_asset_id is null then null else '/api/games/'||g.id||'/media/'||q.mystery_media_asset_id||'/mystery' end,
 'revealMediaPreviewUrl',case when q.reveal_media_asset_id is null then null else '/api/games/'||g.id||'/media/'||q.reveal_media_asset_id||'/reveal' end,
 'choices',(select jsonb_agg(jsonb_build_object('id',c.id,'position',c.position,'text',c.choice_text,'isCorrect',c.is_correct)order by c.position)from public.game_choices c where c.question_id=q.id))order by q.position)
 from public.game_questions q where q.game_id=g.id),'[]'::jsonb))from public.games g where g.id=p_game_id;$$;

create or replace function public.register_game_media_pair(p_admin_token_hash text,p_source_hash text,p_game_id uuid,p_mystery_path text,p_reveal_path text,
 p_mystery_mime text,p_reveal_mime text,p_mystery_bytes integer,p_reveal_bytes integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;asset uuid;total integer;daily jsonb;source_budget jsonb;
begin
 owner:=public.admin_owner_id(p_admin_token_hash);total:=p_mystery_bytes+p_reveal_bytes;
 if not exists(select 1 from public.games where id=p_game_id and owner_id=owner and deleted_at is null)then raise exception using errcode='P0002',message='GAME_NOT_FOUND';end if;
 perform pg_advisory_xact_lock(hashtextextended('game-media-project-quota',0));
 if(select count(*)from public.game_media_assets)>=8000 or coalesce((select sum(byte_size+65536::bigint)from public.game_media_assets),0)+total+65536>4294967296 then raise exception using message='PROJECT_MEDIA_CAPACITY_REACHED';end if;
 if(select count(*)from public.game_media_assets where owner_id=owner)>=500 or coalesce((select sum(byte_size+65536::bigint)from public.game_media_assets where owner_id=owner),0)+total+65536>209715200 then raise exception using message='MEDIA_QUOTA_EXCEEDED';end if;
 if p_mystery_path!~('^game-media/'||owner||'/[0-9a-f-]{36}-mystery\.png$')or p_reveal_path!~('^game-media/'||owner||'/[0-9a-f-]{36}-reveal\.png$')
  or p_mystery_mime<>'image/png'or p_reveal_mime<>'image/png'
  or p_mystery_bytes not between 1 and 5242880 or p_reveal_bytes not between 1 and 5242880
  then raise exception using errcode='22023',message='INVALID_MEDIA';end if;
 source_budget:=public.reserve_media_source_bytes(p_source_hash,total);if not(source_budget->>'allowed')::boolean then raise exception using message='MEDIA_SOURCE_DAILY_LIMITED';end if;
 daily:=public.reserve_project_media_bytes(total);if not(daily->>'allowed')::boolean then raise exception using message='PROJECT_MEDIA_DAILY_LIMITED';end if;
 insert into public.game_media_assets(owner_id,game_id,storage_path,silhouette_storage_path,mime_type,silhouette_mime_type,byte_size,upload_state,
  mystery_storage_path,reveal_storage_path,mystery_mime_type,reveal_mime_type,mystery_byte_size,reveal_byte_size)
 values(owner,p_game_id,p_reveal_path,p_mystery_path,p_reveal_mime,p_mystery_mime,total,'pending',p_mystery_path,p_reveal_path,
  p_mystery_mime,p_reveal_mime,p_mystery_bytes,p_reveal_bytes)returning id into asset;
 return jsonb_build_object('id',asset,'mysteryMimeType',p_mystery_mime,'revealMimeType',p_reveal_mime,'mysteryByteSize',p_mystery_bytes,
  'revealByteSize',p_reveal_bytes,'mysteryPreviewUrl','/api/games/'||p_game_id||'/media/'||asset||'/mystery','revealPreviewUrl','/api/games/'||p_game_id||'/media/'||asset||'/reveal');
end;$$;

create or replace function public.complete_game_media_pair(p_admin_token_hash text,p_game_id uuid,p_media_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;m public.game_media_assets%rowtype;begin owner:=public.admin_owner_id(p_admin_token_hash);
 update public.game_media_assets set upload_state='ready',gc_claimed_at=null where id=p_media_id and game_id=p_game_id and owner_id=owner and upload_state='pending' returning*into m;
 if not found then raise exception using errcode='P0002',message='MEDIA_NOT_FOUND';end if;
 return jsonb_build_object('id',m.id,'mysteryMimeType',m.mystery_mime_type,'revealMimeType',m.reveal_mime_type,'mysteryByteSize',m.mystery_byte_size,
 'revealByteSize',m.reveal_byte_size,'mysteryPreviewUrl','/api/games/'||p_game_id||'/media/'||m.id||'/mystery','revealPreviewUrl','/api/games/'||p_game_id||'/media/'||m.id||'/reveal');end;$$;

create or replace function public.get_game_media_role(p_admin_token_hash text,p_game_id uuid,p_media_id uuid,p_role text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;m public.game_media_assets%rowtype;begin owner:=public.admin_owner_id(p_admin_token_hash);
 select*into m from public.game_media_assets where id=p_media_id and game_id=p_game_id and owner_id=owner and upload_state='ready';if not found then raise exception using message='MEDIA_NOT_FOUND';end if;
 if p_role='mystery'and coalesce(m.mystery_storage_path,m.silhouette_storage_path)is not null then return jsonb_build_object('storagePath',coalesce(m.mystery_storage_path,m.silhouette_storage_path),'mimeType',coalesce(m.mystery_mime_type,m.silhouette_mime_type));
 elsif p_role='reveal'and coalesce(m.reveal_storage_path,m.storage_path)is not null then return jsonb_build_object('storagePath',coalesce(m.reveal_storage_path,m.storage_path),'mimeType',coalesce(m.reveal_mime_type,m.mime_type));end if;
 raise exception using message='MEDIA_NOT_FOUND';end;$$;

-- Snapshot explicit content into new sessions; replay copies the columns below.
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

create or replace function public.room_preload_media(p_code text,p_round integer,p_asset_id uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms%rowtype;q public.session_questions%rowtype;base integer;begin select*into r from public.rooms where code=p_code;if not found then raise exception using message='ROOM_NOT_FOUND';end if;
 base:=coalesce(r.current_round,0);if p_round not between base and base+1 or p_kind not in('mystery','reveal')or r.content_mode<>'saved'then raise exception using message='MEDIA_NOT_REVEALED';end if;
 select*into q from public.session_questions where room_id=r.id and position=p_round and id=p_asset_id;if not found then raise exception using message='MEDIA_NOT_REVEALED';end if;
 if p_kind='mystery'and coalesce(q.mystery_media_path,q.silhouette_media_path)is not null then return jsonb_build_object('storagePath',coalesce(q.mystery_media_path,q.silhouette_media_path),'mimeType',coalesce(q.mystery_media_mime_type,q.silhouette_mime_type),'roundIndex',p_round);end if;
 if p_kind='reveal'and q.reveal_media_path is not null then return jsonb_build_object('storagePath',q.reveal_media_path,'mimeType',q.reveal_media_mime_type,'roundIndex',p_round,
  'key',rtrim(translate(encode(q.reveal_key,'base64'),'+/','-_'),'='),'iv',rtrim(translate(encode(q.reveal_iv,'base64'),'+/','-_'),'='),'aad',q.reveal_aad);end if;
 raise exception using message='MEDIA_NOT_REVEALED';end;$$;

create or replace function public.current_mystery_media_path(p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare r public.rooms%rowtype;q public.session_questions%rowtype;begin
 select*into r from public.rooms where code=p_code;if not found then raise exception using message='ROOM_NOT_FOUND';end if;
 if r.content_mode<>'saved'or r.current_round is null or r.phase not in('question_open','answers_locked')then raise exception using message='MEDIA_NOT_REVEALED';end if;
 select*into q from public.session_questions where room_id=r.id and position=r.current_round;
 if coalesce(q.mystery_media_path,q.silhouette_media_path)is null then raise exception using message='MEDIA_NOT_REVEALED';end if;
 return jsonb_build_object('storagePath',coalesce(q.mystery_media_path,q.silhouette_media_path),'mimeType',coalesce(q.mystery_media_mime_type,q.silhouette_mime_type));end;$$;

create or replace function public.reveal_preload_key(p_code text,p_choice_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms%rowtype;q public.session_questions%rowtype;correct uuid;begin select*into r from public.rooms where code=p_code;if not found then raise exception using message='ROOM_NOT_FOUND';end if;
 if r.phase not in('employee_revealed','results_displayed','complete')or r.content_mode<>'saved'then raise exception using message='MEDIA_NOT_REVEALED';end if;
 select*into q from public.session_questions where room_id=r.id and position=r.current_round;select id into correct from public.session_choices where question_id=q.id and is_correct;
 if correct is distinct from p_choice_id or q.reveal_key is null then raise exception using message='MEDIA_NOT_REVEALED';end if;
 return jsonb_build_object('key',rtrim(translate(encode(q.reveal_key,'base64'),'+/','-_'),'='),'iv',rtrim(translate(encode(q.reveal_iv,'base64'),'+/','-_'),'='),'mimeType',q.reveal_media_mime_type,'aad',q.reveal_aad);end;$$;

create or replace function public.claim_game_media_gc(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;result jsonb;begin owner:=public.admin_owner_id(p_admin_token_hash);
 with candidates as(select m.id from public.game_media_assets m left join public.games g on g.id=m.game_id where m.owner_id=owner
  and not exists(select 1 from public.game_questions q join public.games a on a.id=q.game_id where(q.media_asset_id=m.id or q.mystery_media_asset_id=m.id or q.reveal_media_asset_id=m.id)and a.deleted_at is null)
  and not exists(select 1 from public.session_questions q where q.media_path=m.storage_path or q.silhouette_media_path=m.silhouette_storage_path)
  and((m.upload_state='pending'and m.created_at<now()-interval'1 hour')or(m.upload_state='ready'and(m.created_at<now()-interval'24 hours'or g.deleted_at is not null))or(m.upload_state='deleting'and m.gc_claimed_at<now()-interval'10 minutes'))
  order by m.created_at for update of m skip locked limit 20),claimed as(update public.game_media_assets m set upload_state='deleting',gc_claimed_at=now()from candidates c where m.id=c.id returning m.id,m.storage_path,m.silhouette_storage_path)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'storagePath',storage_path,'silhouetteStoragePath',silhouette_storage_path)),'[]'::jsonb)into result from claimed;return result;end;$$;

create or replace function public.finalize_game_media_gc(p_admin_token_hash text,p_media_ids uuid[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare owner uuid;deleted integer;begin owner:=public.admin_owner_id(p_admin_token_hash);
 with removed as(delete from public.game_media_assets m where m.owner_id=owner and m.upload_state='deleting'and m.id=any(p_media_ids)
  and not exists(select 1 from public.game_questions q join public.games a on a.id=q.game_id where(q.media_asset_id=m.id or q.mystery_media_asset_id=m.id or q.reveal_media_asset_id=m.id)and a.deleted_at is null)
  and not exists(select 1 from public.session_questions q where q.media_path=m.storage_path or q.silhouette_media_path=m.silhouette_storage_path)returning 1)
 select count(*)into deleted from removed;return jsonb_build_object('deletedAssets',deleted);end;$$;

create or replace function public.owner_game_media_paths(p_admin_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$declare owner uuid;begin owner:=public.admin_owner_id(p_admin_token_hash);
 return jsonb_build_object('ownerId',owner,'paths',coalesce((select jsonb_agg(path)from(select storage_path path from public.game_media_assets where owner_id=owner union all select silhouette_storage_path from public.game_media_assets where owner_id=owner)p),'[]'::jsonb));end;$$;

revoke all on function public.register_game_media_pair(text,text,uuid,text,text,text,text,integer,integer),
 public.complete_game_media_pair(text,uuid,uuid),public.get_game_media_role(text,uuid,uuid,text),public.room_preload_media(text,integer,uuid,text),public.current_mystery_media_path(text),public.reveal_preload_key(text,uuid)
 from public,anon,authenticated;
revoke all on function public.reserve_media_source_bytes(text,integer),public.reserve_project_media_bytes(integer)from public,anon,authenticated;
grant execute on function public.register_game_media_pair(text,text,uuid,text,text,text,text,integer,integer),
 public.complete_game_media_pair(text,uuid,uuid),public.get_game_media_role(text,uuid,uuid,text),public.room_preload_media(text,integer,uuid,text),public.current_mystery_media_path(text),public.reveal_preload_key(text,uuid)
 to service_role;
grant execute on function public.reserve_media_source_bytes(text,integer),public.reserve_project_media_bytes(integer)to service_role;

update storage.buckets set public=false,file_size_limit=5242880,
 allowed_mime_types=array['image/jpeg','image/png','image/webp']where id='reveal-media';
