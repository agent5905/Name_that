const version = process.argv[2];
const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;

if (!/^\d{12}$/.test(version ?? '')) throw new Error('A 12-digit migration version is required.');
if (!ref || !token) throw new Error('Supabase management configuration is missing.');

const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `select exists(select 1 from public.app_schema_migrations where version='${version}') as applied`,
  }),
});

if (!response.ok) throw new Error(`Migration ledger query failed (${response.status}).`);
const result = await response.json();
console.log(result[0]?.applied === true ? `MIGRATION_${version}_PRESENT` : `MIGRATION_${version}_ABSENT`);
