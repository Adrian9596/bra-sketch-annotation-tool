#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const port = Number(process.env.PORT || parseArg('--port') || 4173);
const host = process.env.HOST || '127.0.0.1';

const { baseUrl } = await startStaticServer(appDir, { host, port });
console.log(`Bra Measurement Assistant running at ${baseUrl}/`);
console.log('Press Ctrl+C to stop.');

function parseArg(name) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
