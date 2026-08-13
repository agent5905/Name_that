-- Forward repair for production projects that already recorded migration 017.
-- Avoid resolving the legacy rounds alias as the PL/pgSQL rooms record.
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

revoke all on function public.submit_answer(text,uuid,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.submit_answer(text,uuid,text,uuid,integer) to service_role;
