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
const configureAnonymousAuth = async () => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/config/auth`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      external_anonymous_users_enabled: true,
      rate_limit_anonymous_users: 120,
    }),
  });
  if (!response.ok) throw new Error(`Supabase Auth configuration failed (${response.status}).`);
};

const existing = await query("select exists(select 1 from pg_type where typname = 'game_phase') as applied");
if (existing[0]?.applied) {
  console.log('Authoritative game migration is already present; initial schema was not replayed.');
} else {
  await query(await readFile(new URL('../supabase/migrations/202608110001_authoritative_game.sql', import.meta.url), 'utf8'));
  console.log('Applied authoritative game migration.');
}
await query(await readFile(new URL('../supabase/migrations/202608110002_private_realtime_authorization.sql', import.meta.url), 'utf8'));
console.log('Applied idempotent private Realtime authorization patch.');
await configureAnonymousAuth();
console.log('Enabled Anonymous Auth with a bounded 120 sign-ins/hour/IP limit.');
await query(await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8'));
console.log('Upserted four fictional demo members.');
