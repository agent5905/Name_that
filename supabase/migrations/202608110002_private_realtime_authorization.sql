-- Idempotent hosted patch for projects where 202608110001 was already applied.
-- Private Realtime clients must present a JWT with role/exp claims. Browser
-- clients obtain one from a persisted Supabase Anonymous Auth session.
drop policy if exists room_snapshot_broadcast_receive on realtime.messages;
create policy room_snapshot_broadcast_receive on realtime.messages
  for select to anon, authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'
  );

drop policy if exists room_snapshot_broadcast_client_send_deny on realtime.messages;
create policy room_snapshot_broadcast_client_send_deny on realtime.messages
  as restrictive for insert to anon, authenticated
  with check (
    extension <> 'broadcast'
    or realtime.topic() !~ '^room:[A-HJ-NP-Z2-9]{5}$'
  );

create or replace function public.broadcast_room_snapshot_invalidation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_code text := coalesce(new.room_code, old.room_code);
  v_version bigint := coalesce(new.version, old.version);
begin
  perform realtime.send(
    jsonb_build_object('roomCode', v_code, 'version', v_version),
    'room_snapshot_changed',
    'room:' || v_code,
    true
  );
  return null;
end; $$;

revoke all on function public.broadcast_room_snapshot_invalidation() from public, anon, authenticated;
drop trigger if exists room_snapshot_broadcast on public.room_snapshots;
create trigger room_snapshot_broadcast
after insert or update or delete on public.room_snapshots
for each row execute function public.broadcast_room_snapshot_invalidation();

create or replace function public.cleanup_stale_realtime_auth_users()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  delete from auth.users
    where is_anonymous is true
      and created_at < now() - interval '30 days'
      and raw_user_meta_data ->> 'application' = 'name-that-realtime';
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deletedUsers', v_deleted);
end; $$;

revoke all on function public.cleanup_stale_realtime_auth_users() from public, anon, authenticated;
grant execute on function public.cleanup_stale_realtime_auth_users() to service_role;
