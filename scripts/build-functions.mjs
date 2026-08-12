import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const logDirectory = resolve('.wrangler', 'logs');
await mkdir(logDirectory, { recursive: true });

const child = spawn(process.execPath, [resolve('node_modules', 'wrangler', 'bin', 'wrangler.js'), 'pages', 'functions', 'build'], {
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(logDirectory, 'functions-build.log') },
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`Could not start Wrangler: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
