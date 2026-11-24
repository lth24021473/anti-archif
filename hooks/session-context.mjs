#!/usr/bin/env node
/**
 * Antigravity SessionStart hook for Archify.
 *
 * Reads camelCase hook payload from stdin and injects active personal or
 * repository Archify mode directives (`[archify explainer: ...]` /
 * `[archify pr: ...]`) plus existing `.archify/` artifact inventory if present.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractDirectives(filePath) {
  const text = readTextSafe(filePath);
  if (!text) return [];
  const found = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/.test(line)) continue;
    if (marker) {
      fence = marker[1];
      continue;
    }
    const exp = line.match(/^ {0,3}\[archify explainer:[ \t]*(proactive|on-demand|always-on)[ \t]*\][ \t]*$/);
    if (exp) found.push({ kind: 'explainer', mode: exp[1], source: filePath });
    const pr = line.match(/^ {0,3}\[archify pr:[ \t]*(ask|on-demand|proactive)[ \t]*(?:,[ \t]*target[ \t]*=[ \t]*(body|comment)[ \t]*)?\][ \t]*$/);
    if (pr) found.push({ kind: 'pr', mode: pr[1], ...(pr[2] ? { target: pr[2] } : {}), source: filePath });
  }
  return found;
}

function countArchifyFolders(workspaceRoot) {
  const dir = path.join(workspaceRoot, '.archify');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const payload = raw ? JSON.parse(raw) : {};
  const workspacePaths = Array.isArray(payload.workspacePaths) && payload.workspacePaths.length
    ? payload.workspacePaths
    : payload.cwd ? [payload.cwd] : [];

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const directives = [];
  const personalFiles = [
    path.join(home, '.gemini', 'config', 'rules', 'archify.md'),
    path.join(home, '.gemini', 'GEMINI.md'),
  ];
  for (const file of personalFiles) directives.push(...extractDirectives(file));

  let artifactFolders = 0;
  for (const ws of workspacePaths) {
    if (!ws) continue;
    directives.push(...extractDirectives(path.join(ws, 'AGENTS.md')));
    directives.push(...extractDirectives(path.join(ws, 'CONTRIBUTING.md')));
    artifactFolders += countArchifyFolders(ws);
  }

  if (!directives.length && artifactFolders === 0) {
    process.stdout.write('{}\n');
    return;
  }

  const lines = [];
  if (directives.length) {
    const summary = directives
      .map((d) => `${d.kind}=${d.mode}${d.target ? ` (target=${d.target})` : ''} [${path.basename(d.source)}]`)
      .join('; ');
    lines.push(`Active Archify directives: ${summary}.`);
  }
  if (artifactFolders > 0) {
    lines.push(`Workspace contains ${artifactFolders} existing .archify/ artifact folder(s); inspect via archify_studio when needed.`);
  }

  process.stdout.write(`${JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: lines.join(' '),
        },
      },
    ],
  })}\n`);
}

main().catch(() => {
  process.stdout.write('{}\n');
});
