const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const args = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=');
  return separator === -1 ? [argument.replace(/^--/, ''), 'true'] : [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const projectRef = required('SUPABASE_PROJECT_REF');
const accessToken = required('SUPABASE_ACCESS_TOKEN');
const expectedRef = args.get('expected-project-ref');
const apply = args.get('apply') === 'true';
const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/realtime`;
const target = {
  max_concurrent_users: 500,
  max_events_per_second: 500,
  max_joins_per_second: 500,
  max_payload_size_in_kb: 3_000,
};

if (apply && expectedRef !== projectRef) {
  throw new Error('--apply requires --expected-project-ref to exactly match SUPABASE_PROJECT_REF.');
}

async function request(method, body) {
  const payload = body ? JSON.stringify(body) : '';
  const response = await new Promise((resolvePromise, reject) => {
    const pending = httpsRequest(endpoint, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (incoming) => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { text += chunk; });
      incoming.on('end', () => resolvePromise({ status: incoming.statusCode ?? 0, text }));
    });
    pending.on('error', reject);
    if (payload) pending.write(payload);
    pending.end();
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Supabase Realtime configuration request failed (${response.status}).`);
  }
  return response.text ? JSON.parse(response.text) : null;
}

function allowlist(value) {
  return Object.fromEntries(Object.keys(target).map((key) => [key, value[key]]));
}

const before = allowlist(await request('GET'));
if (!apply) {
  console.log(JSON.stringify({ mode: 'read-only', projectRef, current: before, target }, null, 2));
  process.exit(0);
}

for (const [name, value] of Object.entries(before)) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Current ${name} is invalid; refusing to patch.`);
}
await request('PATCH', target);
const after = allowlist(await request('GET'));
for (const [name, value] of Object.entries(target)) {
  if (after[name] !== value) throw new Error(`Supabase did not retain ${name}=${value}.`);
}
console.log(JSON.stringify({ mode: 'applied', projectRef, before, after }, null, 2));
process.exit(0);
import { request as httpsRequest } from 'node:https';
