-- Forward repair for production projects that already recorded migration 017.
-- Qualify trigger-local names so PostgreSQL never confuses them with columns.
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

revoke all on function public.broadcast_room_snapshot_invalidation() from public,anon,authenticated;
