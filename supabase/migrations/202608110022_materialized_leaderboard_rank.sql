-- Materialize the bounded deterministic rank once when a leaderboard snapshot
-- is built. Participant hydration then reads its authenticated player row
-- instead of repeating the same room-wide window sort for every audience member.

alter table public.players
  add column if not exists leaderboard_rank smallint
  check (leaderboard_rank between 1 and 225);

create or replace function public.room_leaderboard(p_room_id uuid,p_limit integer,p_final boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public,pg_temp
as $$
declare board jsonb;
begin
  with ordered as (
    select p.id,row_number()over(order by p.total_score desc,p.correct_answer_count desc,
      p.correct_response_ms asc,p.id asc)::smallint rank
    from public.players p where p.room_id=p_room_id
  )
  update public.players p set leaderboard_rank=o.rank
  from ordered o where p.id=o.id and p.leaderboard_rank is distinct from o.rank;

  select jsonb_build_object(
    'isFinal',p_final,
    'entries',coalesce(jsonb_agg(jsonb_build_object(
      'rank',p.leaderboard_rank,'displayName',p.display_name,'totalScore',p.total_score,
      'correctAnswers',p.correct_answer_count
    )order by p.leaderboard_rank)filter(where p.leaderboard_rank<=least(greatest(p_limit,1),10)),'[]'::jsonb)
  ) into board
  from public.players p where p.room_id=p_room_id;
  return board;
end;
$$;

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
    personal_rank:=p.leaderboard_rank;
    if personal_rank is null then
      select rank into personal_rank from(
        select id,row_number()over(order by total_score desc,correct_answer_count desc,correct_response_ms asc,id asc)::integer rank
        from public.players where room_id=r.id
      ) ranked where id=p.id;
    end if;
    standing:=jsonb_build_object('rank',personal_rank,'totalScore',p.total_score);
  end if;
  return jsonb_build_object('employeeId',answer_id,'totalScore',visible_score,
    'roundFeedback',feedback,'standing',standing);
end;$$;

revoke all on function public.room_leaderboard(uuid,integer,boolean),
  public.participant_answer(text,uuid,text) from public,anon,authenticated;
grant execute on function public.participant_answer(text,uuid,text) to service_role;
