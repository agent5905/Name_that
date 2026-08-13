import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const project = required('CLOUDFLARE_PAGES_PROJECT_NAME');
const url = process.env.SUPABASE_URL ?? required('VITE_SUPABASE_URL');
const secret = required('SUPABASE_SECRET_KEY');
const loadRealtimeAnonKey = async () => {
  if (process.env.SUPABASE_REALTIME_ANON_KEY) return process.env.SUPABASE_REALTIME_ANON_KEY;
  const ref = required('SUPABASE_PROJECT_REF');
  const accessToken = required('SUPABASE_ACCESS_TOKEN');
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Supabase API key read failed (${response.status}).`);
  const keys = await response.json();
  const value = Array.isArray(keys) ? keys.find((candidate) => candidate?.name === 'anon')?.api_key : undefined;
  if (typeof value !== 'string' || value.split('.').length !== 3) {
    throw new Error('The project must retain a legacy anon JWT for private Realtime authorization.');
  }
  return value;
};
const realtimeAnonKey = await loadRealtimeAnonKey();
const wrangler = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const child = spawn(process.execPath, [
  wrangler, 'pages', 'secret', 'bulk', '--project-name', project,
], {
  env: process.env,
  stdio: ['pipe', 'inherit', 'inherit'],
});

child.stdin.end(JSON.stringify({
  SUPABASE_URL: url,
  SUPABASE_SECRET_KEY: secret,
  SUPABASE_REALTIME_ANON_KEY: realtimeAnonKey,
}));

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) process.exitCode = exitCode;
