import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/202608110001_authoritative_game.sql', import.meta.url),
  'utf8',
);
const realtimePatch = readFileSync(
  new URL('../../supabase/migrations/202608110002_private_realtime_authorization.sql', import.meta.url),
  'utf8',
);

describe('authoritative migration regression guards', () => {
  it('computes totals independently and emits one aggregate row per choice', () => {
    expect(migration).toContain("'totalAnswers', (select count(*) from public.answers a where a.round_id = v_round.id)");
    expect(migration).toContain("from public.round_choices c\n      where c.round_id = v_round.id;");
    expect(migration).not.toContain('from public.round_choices c left join public.answers');
  });

  it('requires four members and always seeds the correct member into its four choices', () => {
    expect(migration).toContain('if v_active_count < 4 then');
    expect(migration).toContain('select v_employee.id::uuid as employee_id');
    expect(migration).toContain('e.id <> v_employee.id');
    expect(migration).toContain('limit 3');
  });

  it('uses database CSPRNG bytes for both correct sequence and choice layout', () => {
    expect(migration).toContain('where active order by gen_random_bytes(16)');
    expect(migration.match(/gen_random_bytes\(16\)/g)).toHaveLength(3);
    expect(migration).not.toContain('order by slug loop');
    expect(migration).not.toContain('order by md5');
  });

  it('serializes joins before enforcing the exact 100-player boundary', () => {
    const lock = migration.indexOf('where code = p_code for update', migration.indexOf('function public.join_room'));
    const count = migration.indexOf('select count(*) into v_player_count', lock);
    const cap = migration.indexOf('if v_player_count >= 100', count);
    const insert = migration.indexOf('insert into public.players', cap);
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(cap);
    expect(cap).toBeLessThan(insert);
  });

  it('uses private receive-only code-scoped Broadcast with no snapshot publication or read grant', () => {
    expect(migration).toContain("'room_snapshot_changed'");
    expect(migration).toContain('v_code text := coalesce(new.room_code, old.room_code)');
    expect(migration).toContain("'room:' || v_code");
    expect(migration).toContain("jsonb_build_object('roomCode', v_code, 'version', v_version)");
    expect(migration).toContain('after insert or update or delete on public.room_snapshots');
    expect(migration).toContain('create policy room_snapshot_broadcast_receive on realtime.messages');
    expect(migration).toContain("realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(migration).toContain('create policy room_snapshot_broadcast_client_send_deny on realtime.messages\n  as restrictive for insert to anon, authenticated');
    expect(migration).toContain("realtime.topic() !~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(migration).toMatch(/'room:' \|\| v_code,\s+true\s+\)/);
    expect(migration).not.toContain('alter publication supabase_realtime add table public.room_snapshots');
    expect(migration).not.toContain('grant select on public.room_snapshots to anon');
    expect(migration).not.toContain("'room:' || v_code,\n    false");
  });

  it('ships an idempotent hosted patch for private Realtime authorization', () => {
    expect(realtimePatch).toContain('drop policy if exists room_snapshot_broadcast_receive on realtime.messages');
    expect(realtimePatch).toContain('drop policy if exists room_snapshot_broadcast_client_send_deny on realtime.messages');
    expect(realtimePatch).toContain('drop trigger if exists room_snapshot_broadcast on public.room_snapshots');
    expect(realtimePatch).toContain("realtime.topic() ~ '^room:[A-HJ-NP-Z2-9]{5}$'");
    expect(realtimePatch).toMatch(/'room:' \|\| v_code,\s+true\s+\)/);
    expect(realtimePatch).toContain('create or replace function public.cleanup_stale_realtime_auth_users()');
    expect(realtimePatch).toContain("raw_user_meta_data ->> 'application' = 'name-that-realtime'");
    expect(realtimePatch).toContain("created_at < now() - interval '30 days'");
  });

  it('hardens future defaults and makes the reveal-media client deny restrictive', () => {
    expect(migration).toContain('alter default privileges in schema public revoke all on tables from public, anon, authenticated');
    expect(migration).toContain('alter default privileges in schema public revoke execute on functions from public, anon, authenticated');
    expect(migration).toContain('create policy reveal_media_never_client_select on storage.objects\n  as restrictive for select to anon, authenticated');
  });

  it('atomically persists a hashed-source five-per-fifteen-minute creation gate', () => {
    expect(migration).toContain('create table public.room_creation_limits');
    expect(migration).toContain('source_hash bytea primary key check (octet_length(source_hash) = 32)');
    expect(migration).toContain("v_limit constant integer := 5");
    expect(migration).toContain("v_window constant interval := interval '15 minutes'");
    expect(migration).toContain("where source_hash = decode(p_source_hash, 'hex') for update");
    expect(migration).toContain("'retryAfterSeconds', v_retry_after");
    expect(migration).toContain('grant execute on function public.consume_room_creation_attempt(text), public.cleanup_expired_rooms()\n  to service_role');
  });

  it('expires only completed or inactive rooms under row locks with scoped cascading cleanup', () => {
    expect(migration).toContain("phase = 'complete' and updated_at < now() - interval '12 hours'");
    expect(migration).toContain("updated_at < now() - interval '24 hours'");
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain('delete from public.room_snapshots where room_code = any(v_room_codes)');
    expect(migration).toContain('delete from public.rooms where id = any(v_room_ids)');
  });

  it('cannot end a room before results have already been disclosed', () => {
    expect(migration).toContain("if v_room.phase <> 'results_displayed' then raise exception");
  });

  it('exposes current-round identity only through the host-authenticated RPC', () => {
    expect(migration).toContain("'correctEmployee', v_correct_employee");
    expect(migration).toContain("'isFinalRound', v_room.current_round is not null and v_room.current_round = v_round_count - 1");
    expect(migration).toContain('if v_room.host_token_hash <> decode(p_host_token_hash');
  });
});
