-- Phase changes drive the live presentation and must not wait behind the
-- answer-count invalidation coalescer. The channel remains receive-only and
-- HTTP snapshots remain authoritative; this labels trusted DB invalidations.
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
begin
  perform realtime.send(
    jsonb_build_object('roomCode', v_code, 'version', v_version, 'phase', v_phase),
    'room_snapshot_changed',
    'room:' || v_code,
    true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_room_snapshot_invalidation() from public, anon, authenticated;
