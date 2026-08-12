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
}));

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code ?? 1));
});
if (exitCode !== 0) process.exitCode = exitCode;
