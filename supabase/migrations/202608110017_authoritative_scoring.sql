-- Server-authoritative scoring, personal reveal feedback, and bounded leaderboard
-- projections. Individual answers still produce no audience-wide broadcast.

alter table public.session_questions add column if not exists opened_at timestamptz;
alter table public.rounds add column if not exists opened_at timestamptz;

alter table public.session_answers
  add column if not exists is_correct boolean not null default false,
  add column if not exists authoritative_elapsed_ms integer not null default 0,
  add column if not exists points_awarded smallint not null default 0,
  add column if not exists streak_before smallint not null default 0,
  add column if not exists streak_after smallint not null default 0;
alter table public.answers
  add column if not exists is_correct boolean not null default false,
  add column if not exists authoritative_elapsed_ms integer not null default 0,
  add column if not exists points_awarded smallint not null default 0,
  add column if not exists streak_before smallint not null default 0,
  add column if not exists streak_after smallint not null default 0;

alter table public.session_answers
  add constraint session_answers_scoring_bounds check (
    authoritative_elapsed_ms between 0 and 86400000
    and points_awarded between 0 and 1000
    and streak_before between 0 and 100
    and streak_after between 0 and 100
    and ((not is_correct and points_awarded=0 and streak_after=0)
      or (is_correct and points_awarded between 750 and 1000 and streak_after=streak_before+1))
  ) not valid;
alter table public.answers
  add constraint answers_scoring_bounds check (
    authoritative_elapsed_ms between 0 and 86400000
    and points_awarded between 0 and 1000
    and streak_before between 0 and 100
    and streak_after between 0 and 100
    and ((not is_correct and points_awarded=0 and streak_after=0)
      or (is_correct and points_awarded between 750 and 1000 and streak_after=streak_before+1))
  ) not valid;

alter table public.players
  add column if not exists total_score integer not null default 0 check(total_score between 0 and 100000),
  add column if not exists correct_answer_count smallint not null default 0 check(correct_answer_count between 0 and 100),
  add column if not exists correct_response_ms bigint not null default 0 check(correct_response_ms between 0 and 8640000000),
  add column if not exists current_streak smallint not null default 0 check(current_streak between 0 and 100);

create index if not exists players_room_leaderboard_idx on public.players(
  room_id, total_score desc, correct_answer_count desc, correct_response_ms asc, id asc
) include(display_name,current_streak);

alter table public.room_snapshots add column if not exists leaderboard jsonb;
alter table public.room_snapshots add constraint room_snapshots_leaderboard_phase_check
  check(leaderboard is null or phase in ('leaderboard_displayed','complete')) not valid;

create or replace function public.answer_points(p_correct boolean,p_elapsed_ms integer)
returns smallint
language sql
immutable
strict
set search_path = ''
as $$
  select case when not p_correct then 0 else
    (750 + ((250::bigint * (20000 - least(greatest(p_elapsed_ms,0),20000)) + 10000) / 20000))::smallint
  end;
$$;
revoke all on function public.answer_points(boolean,integer) from public,anon,authenticated;

-- Existing answers predate an authoritative question-open clock. Preserve them
-- conservatively as 20-second answers (base correctness points, no speed bonus).
update public.session_answers a
set is_correct=c.is_correct,
    authoritative_elapsed_ms=20000,
    points_awarded=public.answer_points(c.is_correct,20000),
    streak_before=0,
    streak_after=case when c.is_correct then 1 else 0 end
from public.session_choices c where c.id=a.choice_id;
update public.answers a
set is_correct=(a.employee_id=r.correct_employee_id),
    authoritative_elapsed_ms=20000,
    points_awarded=public.answer_points(a.employee_id=r.correct_employee_id,20000),
    streak_before=0,
    streak_after=case when a.employee_id=r.correct_employee_id then 1 else 0 end
from public.rounds r where r.id=a.round_id;

update public.players p set
  total_score=coalesce(x.score,0),
  correct_answer_count=coalesce(x.correct_count,0),
  correct_response_ms=coalesce(x.correct_ms,0),
  current_streak=0
from (
  select player_id,sum(points_awarded)::integer score,
    count(*)filter(where is_correct)::smallint correct_count,
    coalesce(sum(authoritative_elapsed_ms)filter(where is_correct),0)::bigint correct_ms
  from (
    select player_id,points_awarded,is_correct,authoritative_elapsed_ms from public.session_answers
    union all
    select player_id,points_awarded,is_correct,authoritative_elapsed_ms from public.answers
  ) scored group by player_id
) x where x.player_id=p.id;

update public.session_questions q set opened_at=r.updated_at
from public.rooms r where r.id=q.room_id and q.position=r.current_round and q.opened_at is null;
update public.rounds q set opened_at=r.updated_at
from public.rooms r where r.id=q.room_id and q.round_number=r.current_round and q.opened_at is null;

alter table public.session_answers validate constraint session_answers_scoring_bounds;
alter table public.answers validate constraint answers_scoring_bounds;
alter table public.room_snapshots validate constraint room_snapshots_leaderboard_phase_check;

create or replace function public.room_leaderboard(p_room_id uuid,p_limit integer,p_final boolean)
returns jsonb
language sql
stable
security definer
set search_path = public,pg_temp
as $$
  with ordered as (
    select p.display_name,p.total_score,p.correct_answer_count,
      row_number()over(order by p.total_score desc,p.correct_answer_count desc,
        p.correct_response_ms asc,p.id asc)::integer rank
    from public.players p where p.room_id=p_room_id
  )
  select jsonb_build_object(
    'isFinal',p_final,
    'entries',coalesce((select jsonb_agg(jsonb_build_object(
      'rank',rank,'displayName',display_name,'totalScore',total_score,'correctAnswers',correct_answer_count
    )order by rank)from ordered where rank<=least(greatest(p_limit,1),10)),'[]'::jsonb)
  );
$$;
revoke all on function public.room_leaderboard(uuid,integer,boolean) from public,anon,authenticated;

create or replace function public.refresh_room_snapshot(p_room_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.rooms%rowtype;legacy_round public.rounds%rowtype;q public.session_questions%rowtype;
  choices jsonb:='[]'::jsonb;reveal jsonb;result jsonb;board jsonb;
  round_count integer;player_count integer;eligible_count integer;answer_count integer:=0;correct_id uuid;last_round integer;
begin
  select*into strict r from public.rooms where id=p_room_id;
  select count(*)into player_count from public.players where room_id=p_room_id;
  select count(*)into eligible_count from public.players where room_id=p_room_id
    and(r.current_round is null or eligible_from_round<=r.current_round);
  if r.content_mode='saved' then
    select count(*)into round_count from public.session_questions where room_id=p_room_id;
    if r.current_round is not null then
      select*into strict q from public.session_questions where room_id=p_room_id and position=r.current_round;
      select id into strict correct_id from public.session_choices where question_id=q.id and is_correct;
      select coalesce(jsonb_agg(jsonb_build_object('id',id,'displayName',choice_text,'position',position)order by position),'[]'::jsonb)
        into choices from public.session_choices where question_id=q.id;
      select count(*)into answer_count from public.session_answers where question_id=q.id;
      if r.phase in('employee_revealed','results_displayed','complete')then
        reveal:=jsonb_build_object('id',correct_id,'displayName',q.reveal_name,'team','','funFact','',
          'mediaAvailable',q.media_path is not null);
      end if;
      if r.phase in('results_displayed','complete')then
        select jsonb_build_object('totalAnswers',(select count(*)from public.session_answers where question_id=q.id),
          'correctAnswers',(select count(*)from public.session_answers where question_id=q.id and choice_id=correct_id),
          'choices',coalesce(jsonb_agg(jsonb_build_object('employeeId',c.id,'count',
            (select count(*)from public.session_answers a where a.question_id=q.id and a.choice_id=c.id))order by c.position),'[]'::jsonb))
          into result from public.session_choices c where c.question_id=q.id;
      end if;
    end if;
  else
    select count(*)into round_count from public.rounds where room_id=p_room_id;
    if r.current_round is not null then
      select*into strict legacy_round from public.rounds where room_id=p_room_id and round_number=r.current_round;
      correct_id:=legacy_round.correct_employee_id;
      select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'displayName',e.display_name,'position',c.position)order by c.position),'[]'::jsonb)
        into choices from public.round_choices c join public.employees e on e.id=c.employee_id where c.round_id=legacy_round.id;
      select count(*)into answer_count from public.answers where round_id=legacy_round.id;
      if r.phase in('employee_revealed','results_displayed','complete')then
        select jsonb_build_object('id',e.id,'displayName',e.display_name,'team',e.team,'funFact',e.fun_fact,'mediaAvailable',true)
          into reveal from public.employees e where e.id=correct_id;
      end if;
      if r.phase in('results_displayed','complete')then
        select jsonb_build_object('totalAnswers',(select count(*)from public.answers where round_id=legacy_round.id),
          'correctAnswers',(select count(*)from public.answers where round_id=legacy_round.id and employee_id=correct_id),
          'choices',coalesce(jsonb_agg(jsonb_build_object('employeeId',c.employee_id,'count',
            (select count(*)from public.answers a where a.round_id=legacy_round.id and a.employee_id=c.employee_id))order by c.position),'[]'::jsonb))
          into result from public.round_choices c where c.round_id=legacy_round.id;
      end if;
    end if;
  end if;
  last_round:=round_count-1;
  if r.phase='leaderboard_displayed'then
    board:=public.room_leaderboard(r.id,case when r.current_round=last_round then 10 else 5 end,r.current_round=last_round);
  elsif r.phase='complete'then board:=public.room_leaderboard(r.id,10,true);end if;
  insert into public.room_snapshots(room_code,phase,round_index,round_count,connected_participant_count,eligible_participant_count,
    prompt,silhouette_url,submitted_answer_count,version,choices,revealed_employee,results,leaderboard,updated_at)
  values(r.code,r.phase,r.current_round,round_count,player_count,eligible_count,
    case when r.content_mode='saved'and r.current_round is not null then q.prompt else'Name that team member'end,
    case when r.content_mode='saved'and r.current_round is not null then'/api/rooms/'||r.code||'/silhouette'else null end,
    answer_count,r.version,choices,reveal,result,board,clock_timestamp())
  on conflict(room_code)do update set phase=excluded.phase,round_index=excluded.round_index,round_count=excluded.round_count,
    connected_participant_count=excluded.connected_participant_count,eligible_participant_count=excluded.eligible_participant_count,
    prompt=excluded.prompt,silhouette_url=excluded.silhouette_url,submitted_answer_count=excluded.submitted_answer_count,
    version=excluded.version,choices=excluded.choices,revealed_employee=excluded.revealed_employee,results=excluded.results,
    leaderboard=excluded.leaderboard,updated_at=excluded.updated_at;
end;$$;

-- Leaderboard joins are reconciled into the HTTP projection, but the existing
-- phase-only broadcast trigger deliberately suppresses this same-phase write.
create or replace function public.update_join_snapshot_progress()
returns trigger language plpgsql security definer set search_path='' as $$
declare phase public.game_phase;
begin
  select r.phase into phase from public.rooms r where r.id=new.room_id;
  if phase='leaderboard_displayed'then
    perform public.refresh_room_snapshot(new.room_id);
  else
    update public.room_snapshots s set
      connected_participant_count=s.connected_participant_count+1,
      eligible_participant_count=s.eligible_participant_count+
        case when r.current_round is null or new.eligible_from_round<=r.current_round then 1 else 0 end,
      updated_at=clock_timestamp()
    from public.rooms r where r.id=new.room_id and s.room_code=r.code;
  end if;
  return null;
end;$$;
revoke all on function public.update_join_snapshot_progress() from public,anon,authenticated;

drop function if exists public.submit_answer(text,uuid,text,uuid);
create or replace function public.submit_answer(
  p_code text,p_player_id uuid,p_participant_token_hash text,p_employee_id uuid,p_expected_round integer
)returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.rooms%rowtype;p public.players%rowtype;qid uuid;opened timestamptz;existing uuid;
  correct boolean;accepted timestamptz;elapsed integer;points smallint;after_streak smallint;
begin
  if p_expected_round not between 0 and 99 then raise exception using errcode='22023',message='INVALID_INPUT';end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('room-answer-gate:'||p_code,0));
  select*into r from public.rooms where code=p_code;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND';end if;
  select*into p from public.players where id=p_player_id and room_id=r.id
    and participant_token_hash=decode(p_participant_token_hash,'hex')for update;
  if not found then raise exception using errcode='42501',message='PARTICIPANT_UNAUTHORIZED';end if;
  if r.content_mode='saved'then
    select id,opened_at into qid,opened from public.session_questions where room_id=r.id and position=p_expected_round;
    if not found then raise exception using errcode='22023',message='INVALID_CHOICE';end if;
    select choice_id into existing from public.session_answers where question_id=qid and player_id=p_player_id;
  else
    select id,opened_at into qid,opened from public.rounds where room_id=r.id and round_number=p_expected_round;
    if not found then raise exception using errcode='22023',message='INVALID_CHOICE';end if;
    select employee_id into existing from public.answers where round_id=qid and player_id=p_player_id;
  end if;
  if existing is not null then
    if existing<>p_employee_id then raise exception using errcode='P0001',message='ANSWER_IMMUTABLE';end if;
    return jsonb_build_object('accepted',true,'idempotent',true,'employeeId',existing,'roundIndex',p_expected_round);
  end if;
  if r.phase<>'question_open'or r.current_round<>p_expected_round or p.eligible_from_round>p_expected_round then
    raise exception using errcode='P0001',message='ANSWERS_CLOSED';
  end if;
  if r.content_mode='saved'then
    select is_correct into correct from public.session_choices where question_id=qid and id=p_employee_id;
  else
    select(legacy_round.correct_employee_id=p_employee_id)into correct from public.rounds legacy_round
      where legacy_round.id=qid and exists(select 1 from public.round_choices c where c.round_id=qid and c.employee_id=p_employee_id);
  end if;
  if correct is null then raise exception using errcode='22023',message='INVALID_CHOICE';end if;
  accepted:=clock_timestamp();
  elapsed:=least(86400000,greatest(0,floor(extract(epoch from(accepted-coalesce(opened,r.updated_at)))*1000)::integer));
  points:=public.answer_points(correct,elapsed);
  after_streak:=case when correct then p.current_streak+1 else 0 end;
  if r.content_mode='saved'then
    insert into public.session_answers(room_id,question_id,player_id,choice_id,submitted_at,is_correct,
      authoritative_elapsed_ms,points_awarded,streak_before,streak_after)
    values(r.id,qid,p_player_id,p_employee_id,accepted,correct,elapsed,points,p.current_streak,after_streak)
    on conflict(question_id,player_id)do nothing returning choice_id into existing;
  else
    insert into public.answers(room_id,round_id,player_id,employee_id,submitted_at,is_correct,
      authoritative_elapsed_ms,points_awarded,streak_before,streak_after)
    values(r.id,qid,p_player_id,p_employee_id,accepted,correct,elapsed,points,p.current_streak,after_streak)
    on conflict(round_id,player_id)do nothing returning employee_id into existing;
  end if;
  if existing is null then raise exception using errcode='40001',message='ANSWER_RETRY_REQUIRED';end if;
  update public.players set total_score=total_score+points,
    correct_answer_count=correct_answer_count+case when correct then 1 else 0 end,
    correct_response_ms=correct_response_ms+case when correct then elapsed else 0 end,
    current_streak=after_streak where id=p_player_id;
  return jsonb_build_object('accepted',true,'idempotent',false,'employeeId',existing,'roundIndex',p_expected_round);
end;$$;

create or replace function public.participant_answer(p_code text,p_player_id uuid,p_participant_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.rooms%rowtype;p public.players%rowtype;qid uuid;answer_id uuid;correct boolean;points smallint;
  before_streak smallint;after_streak smallint;visible_score integer;personal_rank integer;feedback jsonb;standing jsonb;
begin
  select*into r from public.rooms where code=p_code;if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND';end if;
  select*into p from public.players where id=p_player_id and room_id=r.id
    and participant_token_hash=decode(p_participant_token_hash,'hex');
  if not found then raise exception using errcode='42501',message='PARTICIPANT_UNAUTHORIZED';end if;
  if r.current_round is not null then
    if r.content_mode='saved'then
      select id into qid from public.session_questions where room_id=r.id and position=r.current_round;
      select choice_id,is_correct,points_awarded,streak_before,streak_after
        into answer_id,correct,points,before_streak,after_streak from public.session_answers
        where question_id=qid and player_id=p_player_id;
    else
      select id into qid from public.rounds where room_id=r.id and round_number=r.current_round;
      select employee_id,is_correct,points_awarded,streak_before,streak_after
        into answer_id,correct,points,before_streak,after_streak from public.answers
        where round_id=qid and player_id=p_player_id;
    end if;
  end if;
  visible_score:=p.total_score;
  if r.phase in('question_open','answers_locked')and answer_id is not null then
    visible_score:=p.total_score-points;
  elsif r.phase in('employee_revealed','results_displayed','leaderboard_displayed','complete')and p.eligible_from_round<=r.current_round then
    if answer_id is null then feedback:=jsonb_build_object('roundIndex',r.current_round,'outcome','no_answer','points',0,'streak',p.current_streak);
    else feedback:=jsonb_build_object('roundIndex',r.current_round,'outcome',case when correct then'correct'else'incorrect'end,
      'points',points,'streak',after_streak);end if;
  end if;
  if r.phase in('leaderboard_displayed','complete')then
    select rank into personal_rank from(
      select id,row_number()over(order by total_score desc,correct_answer_count desc,correct_response_ms asc,id asc)::integer rank
      from public.players where room_id=r.id
    ) ranked where id=p.id;
    standing:=jsonb_build_object('rank',personal_rank,'totalScore',p.total_score);
  end if;
  return jsonb_build_object('employeeId',answer_id,'totalScore',visible_score,
    'roundFeedback',feedback,'standing',standing);
end;$$;

create or replace function public.host_action(p_code text,p_host_token_hash text,p_action text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms%rowtype;last_round integer;opened timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-answer-gate:'||p_code,0));
  select*into r from public.rooms where code=p_code for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND';end if;
  if r.host_token_hash<>decode(p_host_token_hash,'hex')then raise exception using errcode='42501',message='HOST_UNAUTHORIZED';end if;
  if r.content_mode='saved'then select max(position)into last_round from public.session_questions where room_id=r.id;
  else select max(round_number)into last_round from public.rounds where room_id=r.id;end if;
  case p_action
    when'start'then
      if r.phase<>'lobby'or last_round is null then raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;
      r.phase:='question_open';r.current_round:=0;opened:=clock_timestamp();
    when'lock'then
      if r.phase<>'question_open'then raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;r.phase:='answers_locked';
    when'reveal'then
      if r.phase<>'answers_locked'then raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;
      if r.content_mode='saved'then
        update public.players p set current_streak=0 where p.room_id=r.id and p.eligible_from_round<=r.current_round
          and p.current_streak<>0 and not exists(select 1 from public.session_answers a join public.session_questions q on q.id=a.question_id
            where q.room_id=r.id and q.position=r.current_round and a.player_id=p.id);
      else
        update public.players p set current_streak=0 where p.room_id=r.id and p.eligible_from_round<=r.current_round
          and p.current_streak<>0 and not exists(select 1 from public.answers a join public.rounds q on q.id=a.round_id
            where q.room_id=r.id and q.round_number=r.current_round and a.player_id=p.id);
      end if;
      r.phase:='employee_revealed';
    when'show_results'then
      if r.phase<>'employee_revealed'then raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;r.phase:='results_displayed';
    when'show_leaderboard'then
      if r.phase<>'results_displayed'then raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;r.phase:='leaderboard_displayed';
    when'next_round'then
      if r.phase not in('results_displayed','leaderboard_displayed')or r.current_round>=last_round then
        raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;
      r.phase:='question_open';r.current_round:=r.current_round+1;opened:=clock_timestamp();
    when'end'then
      if r.phase<>'leaderboard_displayed'or r.current_round<>last_round then
        raise exception using errcode='P0001',message='ILLEGAL_TRANSITION';end if;r.phase:='complete';
    else raise exception using errcode='22023',message='INVALID_ACTION';
  end case;
  if opened is not null then
    if r.content_mode='saved'then update public.session_questions set opened_at=opened where room_id=r.id and position=r.current_round;
    else update public.rounds set opened_at=opened where room_id=r.id and round_number=r.current_round;end if;
  end if;
  update public.rooms set phase=r.phase,current_round=r.current_round,version=version+1,updated_at=clock_timestamp()where id=r.id;
  perform public.refresh_room_snapshot(r.id);
  return(select to_jsonb(s)from public.room_snapshots s where room_code=p_code);
end;$$;

create or replace function public.host_action_direct(p_code text,p_host_token text,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare expected bytea;supplied bytea;
begin
  if p_code is null or p_host_token is null or p_action is null or p_code!~'^[A-HJ-NP-Z2-9]{5}$'
    or p_host_token!~'^[A-Za-z0-9_-]{43}$'
    or p_action not in('start','lock','reveal','show_results','show_leaderboard','next_round','end')then
    raise exception using errcode='22023',message='INVALID_INPUT';
  end if;
  supplied:=extensions.digest(p_host_token,'sha256');
  select r.host_token_hash into expected from public.rooms r where r.code=p_code;
  if not found or expected is distinct from supplied then raise exception using errcode='42501',message='HOST_UNAUTHORIZED';end if;
  return public.host_action(p_code,pg_catalog.encode(supplied,'hex'),p_action);
end;$$;

create or replace function public.broadcast_room_snapshot_invalidation()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_code text;v_version bigint;v_phase text;revealed jsonb;reveal_key jsonb;snapshot jsonb;
begin
  if tg_op='DELETE'then return null;end if;
  if tg_op='UPDATE'and new.phase is not distinct from old.phase and new.round_index is not distinct from old.round_index then return null;end if;
  v_code:=new.room_code;v_version:=new.version;v_phase:=new.phase;revealed:=new.revealed_employee;
  if new.phase in('employee_revealed','results_displayed','complete')and revealed is not null then
    select jsonb_build_object('key',rtrim(translate(encode(q.reveal_key,'base64'),'+/','-_'),'='),
      'iv',rtrim(translate(encode(q.reveal_iv,'base64'),'+/','-_'),'='),'mimeType',q.reveal_media_mime_type,'aad',q.reveal_aad)
      into reveal_key from public.rooms r join public.session_questions q on q.room_id=r.id and q.position=r.current_round
      where r.code=v_code and r.content_mode='saved'and q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null;
    if reveal_key is not null then revealed:=revealed||jsonb_build_object('revealKey',reveal_key);end if;
  end if;
  snapshot:=jsonb_build_object('roomCode',new.room_code,'phase',new.phase,'roundIndex',new.round_index,
    'roundCount',new.round_count,'connectedParticipantCount',new.connected_participant_count,
    'eligibleParticipantCount',new.eligible_participant_count,'submittedAnswerCount',new.submitted_answer_count,
    'version',new.version,'choices',new.choices,'prompt',new.prompt,'silhouetteUrl',new.silhouette_url,
    'mysteryImageUrl',new.mystery_image_url,'preloadAssets',new.preload_assets,'revealedEmployee',revealed,
    'results',new.results,'leaderboard',new.leaderboard,'updatedAt',new.updated_at);
  perform realtime.send(jsonb_build_object('roomCode',v_code,'version',v_version,'phase',v_phase,'snapshot',snapshot),
    'room_snapshot_changed','room:'||v_code,true);
  return null;
end;$$;

revoke all on function public.submit_answer(text,uuid,text,uuid,integer),public.participant_answer(text,uuid,text),
  public.host_action(text,text,text) from public,anon,authenticated;
grant execute on function public.submit_answer(text,uuid,text,uuid,integer),public.participant_answer(text,uuid,text),
  public.host_action(text,text,text) to service_role;
revoke all on function public.broadcast_room_snapshot_invalidation() from public,anon,authenticated;
revoke all on function public.host_action_direct(text,text,text) from public;
grant execute on function public.host_action_direct(text,text,text) to anon,authenticated;
