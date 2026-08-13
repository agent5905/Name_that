-- A private, receive-only phase event can carry the server-owned sanitized
-- projection. This removes a redundant participant HTTP round trip. Reveal
-- material is attached only when the public key endpoint would already allow
-- it, and remains unique to this room/question.
create or replace function public.broadcast_room_snapshot_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := coalesce(new.room_code, old.room_code);
  v_version bigint := coalesce(new.version, old.version);
  v_phase text := coalesce(new.phase, old.phase);
  v_revealed jsonb;
  v_key jsonb;
  v_snapshot jsonb;
begin
  if tg_op <> 'DELETE' and (tg_op='INSERT' or new.phase is distinct from old.phase or new.round_index is distinct from old.round_index) then
    v_revealed := new.revealed_employee;
    if new.phase in ('employee_revealed','results_displayed','complete') and new.revealed_employee is not null then
      select jsonb_build_object(
        'key', rtrim(translate(encode(q.reveal_key,'base64'),'+/','-_'),'='),
        'iv', rtrim(translate(encode(q.reveal_iv,'base64'),'+/','-_'),'='),
        'mimeType', q.reveal_media_mime_type,
        'aad', q.reveal_aad
      ) into v_key
      from public.rooms r
      join public.session_questions q on q.room_id=r.id and q.position=r.current_round
      where r.code=v_code and r.content_mode='saved'
        and q.reveal_key is not null and q.reveal_iv is not null and q.reveal_aad is not null;
      if v_key is not null then v_revealed := v_revealed || jsonb_build_object('revealKey',v_key); end if;
    end if;
    v_snapshot := jsonb_build_object(
      'roomCode',new.room_code,'phase',new.phase,'roundIndex',new.round_index,'roundCount',new.round_count,
      'connectedParticipantCount',new.connected_participant_count,
      'eligibleParticipantCount',new.eligible_participant_count,
      'submittedAnswerCount',new.submitted_answer_count,'version',new.version,'choices',new.choices,
      'prompt',new.prompt,'silhouetteUrl',new.silhouette_url,'mysteryImageUrl',new.mystery_image_url,
      'preloadAssets',new.preload_assets,'revealedEmployee',v_revealed,'results',new.results,'updatedAt',new.updated_at
    );
  end if;
  perform realtime.send(
    jsonb_build_object('roomCode',v_code,'version',v_version,'phase',v_phase,'snapshot',v_snapshot),
    'room_snapshot_changed','room:'||v_code,true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_room_snapshot_invalidation() from public, anon, authenticated;
