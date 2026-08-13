import { readFile } from 'node:fs/promises';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const ref = required('SUPABASE_PROJECT_REF');
const token = required('SUPABASE_ACCESS_TOKEN');
const query = async (sql) => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!response.ok) throw new Error(`Supabase management query failed (${response.status}).`);
  return response.json();
};

await query(`create table if not exists public.app_schema_migrations (
  version text primary key, applied_at timestamptz not null default now()
); revoke all on public.app_schema_migrations from public, anon, authenticated;`);
const ordered = [
  ['202608110001', '../supabase/migrations/202608110001_authoritative_game.sql'],
  ['202608110002', '../supabase/migrations/202608110002_private_realtime_authorization.sql'],
  ['202608110003', '../supabase/migrations/202608110003_saved_games_and_repeatable_sessions.sql'],
  ['202608110004', '../supabase/migrations/202608110004_security_hardening.sql'],
  ['202608110005', '../supabase/migrations/202608110005_media_reservations_and_gc.sql'],
  ['202608110006', '../supabase/migrations/202608110006_aggregate_media_limits.sql'],
  ['202608110007', '../supabase/migrations/202608110007_project_daily_budget_and_cleanup.sql'],
  ['202608110008', '../supabase/migrations/202608110008_game_churn_and_atomic_budget.sql'],
  ['202608110009', '../supabase/migrations/202608110009_atomic_game_budgets.sql'],
  ['202608110010', '../supabase/migrations/202608110010_explicit_mystery_reveal_media.sql'],
  ['202608110011', '../supabase/migrations/202608110011_session_crypto_search_path.sql'],
  ['202608110012', '../supabase/migrations/202608110012_priority_phase_broadcast.sql'],
  ['202608110013', '../supabase/migrations/202608110013_authoritative_phase_push.sql'],
  ['202608110014', '../supabase/migrations/202608110014_direct_host_phase_action.sql'],
  ['202608110015', '../supabase/migrations/202608110015_225_participant_capacity.sql'],
  ['202608110016', '../supabase/migrations/202608110016_leaderboard_phase.sql'],
  ['202608110017', '../supabase/migrations/202608110017_authoritative_scoring.sql'],
];
const initial = await query("select exists(select 1 from pg_type where typname='game_phase') as applied");
if (initial[0]?.applied) await query("insert into public.app_schema_migrations(version) values('202608110001') on conflict do nothing");
for (const [version, file] of ordered) {
  const present = await query(`select exists(select 1 from public.app_schema_migrations where version='${version}') as applied`);
  if (present[0]?.applied) { console.log(`Migration ${version} already applied.`); continue; }
  const sql = await readFile(new URL(file, import.meta.url), 'utf8');
  await query(`begin; ${sql}; insert into public.app_schema_migrations(version) values('${version}'); commit;`);
  console.log(`Applied migration ${version}.`);
}
await query(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
console.log('Upserted four fictional demo members.');
