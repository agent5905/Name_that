import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt', '.xml']);
const serverOnlyNames = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'CLOUDFLARE_API_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return nested.flat();
}

const files = await filesUnder(outputDirectory);
const maps = files.filter((path) => extname(path) === '.map');
assert.equal(maps.length, 0, 'Public production output must not contain source maps.');

const textFiles = files.filter((path) => textExtensions.has(extname(path)));
const findings = [];
for (const path of textFiles) {
  const contents = await readFile(path, 'utf8');
  for (const name of serverOnlyNames) {
    if (contents.includes(name)) findings.push(`${relative(outputDirectory, path)} contains server-only identifier ${name}`);
    const value = process.env[name];
    if (value && value.length >= 12 && !/^your_|^replace_/i.test(value) && contents.includes(value)) {
      findings.push(`${relative(outputDirectory, path)} contains the configured value for ${name}`);
    }
  }
}

assert.equal(findings.length, 0, `Public bundle secret scan failed:\n${findings.join('\n')}`);
console.log(`Public bundle secret scan passed (${files.length} artifacts, ${textFiles.length} text artifacts, no source maps).`);
