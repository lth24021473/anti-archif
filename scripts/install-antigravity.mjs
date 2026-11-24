#!/usr/bin/env node
/**
 * Safe installer for the Archify Antigravity plugin.
 *
 * Copies or links this plugin into either:
 *   - Global:    ~/.gemini/config/plugins/archify  (--global)
 *   - Workspace: <dir>/.agents/plugins/archify     (--workspace <dir>)
 *
 * Never edits ~/.gemini/config/config.json directly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COPY_ENTRIES = [
  'plugin.json',
  'mcp_config.json',
  'hooks.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'LICENSE-MIT',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'rules',
  'hooks',
  'skills',
  'agents',
  'mcp',
  'engine',
  'viewer',
  'scripts',
  'node_modules',
];

function parseArgs(argv) {
  const opts = { global: false, workspace: null, mode: 'copy', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--global') opts.global = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--workspace') opts.workspace = argv[++i];
    else if (arg.startsWith('--workspace=')) opts.workspace = arg.slice('--workspace='.length);
    else if (arg === '--mode') opts.mode = argv[++i];
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/install-antigravity.mjs (--global | --workspace <dir>) [--mode copy|link] [--force]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.global && !opts.workspace) {
    throw new Error('Specify --global or --workspace <dir>.');
  }
  if (!['copy', 'link'].includes(opts.mode)) {
    throw new Error(`--mode must be "copy" or "link", got "${opts.mode}".`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const dest = opts.global
    ? path.join(home, '.gemini', 'config', 'plugins', 'archify')
    : path.join(path.resolve(opts.workspace), '.agents', 'plugins', 'archify');

  if (fs.existsSync(dest)) {
    if (!opts.force) {
      throw new Error(
        `Destination already exists: ${dest}. Inspect it or pass --force to replace it.`,
      );
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (opts.mode === 'link') {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(ROOT, dest, linkType);
  } else {
    fs.mkdirSync(dest, { recursive: true });
    for (const rel of COPY_ENTRIES) {
      const srcPath = path.join(ROOT, rel);
      if (!fs.existsSync(srcPath)) continue;
      fs.cpSync(srcPath, path.join(dest, rel), {
        recursive: true,
        filter: (p) => !path.basename(p).startsWith('.smoke_') && !path.basename(p).startsWith('_upstream'),
      });
    }
  }

  const doctor = spawnSync(process.execPath, [path.join(dest, 'engine', 'bin', 'archify.mjs'), 'doctor'], {
    stdio: 'inherit',
  });
  if (doctor.status !== 0) {
    throw new Error('Installed plugin failed doctor check.');
  }

  console.log(`\nInstalled Archify Antigravity plugin to: ${dest}`);
  console.log('Manage it live in Antigravity Customizations: [archify](customization://archify)');
}

try {
  main();
} catch (error) {
  console.error(`install-antigravity: ${error.message}`);
  process.exitCode = 1;
}
