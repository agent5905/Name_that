-- Return the public room snapshot and private participant projection from one
-- transition-stable transaction. The Pages endpoint previously fetched these
-- independently, so a host phase change between the reads could make strict
-- pre/post-Reveal validation reject an otherwise valid projection.

create or replace function public.participant_room_snapshot(
  p_code text,
  p_player_id uuid,
  p_participant_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
  v_participant jsonb;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('room-answer-gate:' || p_code, 0));
  v_participant := public.participant_answer(p_code, p_player_id, p_participant_token_hash);

  select to_jsonb(s) into v_snapshot
  from public.room_snapshots s
  where s.room_code = p_code;

  if v_snapshot is null then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  return jsonb_build_object('snapshot', v_snapshot, 'participant', v_participant);
end;
$$;

revoke all on function public.participant_room_snapshot(text, uuid, text) from public, anon, authenticated;
grant execute on function public.participant_room_snapshot(text, uuid, text) to service_role;
