#!/usr/bin/env node
/**
 * Quick preflight parity & build check across viewer template, MCP App bundle,
 * and Archify engine doctor.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runStep(label, args) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`[FAIL] ${label}\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
  console.log(`[ok] ${label}`);
}

runStep('Viewer template sync (--check)', ['scripts/generate-viewer.mjs', '--check']);
runStep('MCP App single-file bundle', ['scripts/build-mcp-app.mjs']);
runStep('Engine doctor (all 11 types + runtimes)', ['engine/bin/archify.mjs', 'doctor']);

const appHtml = path.join(ROOT, 'mcp', 'dist', 'viewer.html');
const appSize = fs.statSync(appHtml).size;
console.log(`[ok] MCP App bundle size: ${(appSize / 1024).toFixed(1)} KiB`);
console.log('\nArchify Antigravity plugin parity & runtime build verified.');
