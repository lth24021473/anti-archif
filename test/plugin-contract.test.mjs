import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OFFICIAL_PLUGIN_FIELDS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'logo',
  'author',
  'homepage',
  'repository',
  'suggestedPrompts',
  'disabled',
]);

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'Expected YAML frontmatter');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

test('plugin.json contains only official Antigravity fields and valid logo/prompts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'archify');
  assert.equal(manifest.displayName, 'Archify');
  assert.ok(manifest.description && manifest.description.length > 20);
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length === 3);
  for (const key of Object.keys(manifest)) {
    assert.ok(OFFICIAL_PLUGIN_FIELDS.has(key), `Unexpected top-level field in plugin.json: ${key}`);
  }
  const logoSvg = fs.readFileSync(path.join(ROOT, manifest.logo), 'utf8');
  assert.match(logoSvg, /<svg\b[^>]*width="128"[^>]*height="128"/);
});

test('mcp_config.json uses ${PLUGIN_ROOT} and ${PLUGIN_DATA}', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp_config.json'), 'utf8'));
  assert.ok(config.mcpServers?.archify);
  assert.equal(config.mcpServers.archify.command, 'node');
  assert.deepEqual(config.mcpServers.archify.args, [
    '${PLUGIN_ROOT}/mcp/server.mjs',
    '--data-dir',
    '${PLUGIN_DATA}',
  ]);
  assert.ok(fs.existsSync(path.join(ROOT, 'mcp', 'server.mjs')));
});

test('hooks.json sits at plugin root and session-context hook speaks camelCase JSON', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8'));
  const sessionStart = hooks['archify-session-context']?.SessionStart;
  assert.ok(Array.isArray(sessionStart) && sessionStart.length === 1);
  assert.equal(sessionStart[0].type, 'command');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-hook-'));
  try {
    const emptyRes = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-context.mjs')], {
      cwd: ROOT,
      input: JSON.stringify({
        conversationId: 'test-conv',
        workspacePaths: [tmp],
        cwd: tmp,
        hookEventName: 'SessionStart',
      }),
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      encoding: 'utf8',
    });
    assert.equal(emptyRes.status, 0);
    assert.deepEqual(JSON.parse(emptyRes.stdout), {});

    fs.mkdirSync(path.join(tmp, '.archify', 'architecture-demo'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '[archify explainer: on-demand]\n', 'utf8');

    const activeRes = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-context.mjs')], {
      cwd: ROOT,
      input: JSON.stringify({
        conversationId: 'test-conv',
        workspacePaths: [tmp],
        cwd: tmp,
        hookEventName: 'SessionStart',
      }),
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      encoding: 'utf8',
    });
    assert.equal(activeRes.status, 0);
    const parsed = JSON.parse(activeRes.stdout);
    assert.ok(Array.isArray(parsed.injectSteps) && parsed.injectSteps.length === 1);
    const msg = parsed.injectSteps[0]?.systemMessage?.systemMessage || '';
    assert.match(msg, /explainer=on-demand/);
    assert.match(msg, /\.archify\//);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rules/AGENTS.md is plain markdown without YAML frontmatter and under 24 KB', () => {
  const rulesPath = path.join(ROOT, 'rules', 'AGENTS.md');
  const content = fs.readFileSync(rulesPath, 'utf8');
  assert.ok(!content.startsWith('---'), 'Plugin rules/AGENTS.md must not contain YAML frontmatter');
  assert.ok(Buffer.byteLength(content, 'utf8') < 24_000);
});

test('skills match Antigravity frontmatter contract and keep references intact', () => {
  for (const skillName of ['archify', 'archify-pr']) {
    const skillMd = fs.readFileSync(path.join(ROOT, 'skills', skillName, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(skillMd);
    assert.equal(fm.name, skillName);
    assert.ok(fm.description && fm.description.length > 20);
  }
  for (const ref of [
    'authoring-contract.md',
    'authoring-defaults.md',
    'brand-marks.md',
    'delivery-contract.md',
    'explainer-authoring.md',
    'pr-review.md',
    'repository-authoring.md',
    'story-authoring.md',
    'update-awareness.md',
    'viewer-runtime.md',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'archify', 'references', ref)), `Missing reference: ${ref}`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'archify-pr', 'references', 'pr-workflow.md')));
});

test('subagents declare valid Antigravity metadata without model/color', () => {
  const agentFiles = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md'));
  assert.equal(agentFiles.length, 4);
  for (const file of agentFiles) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'agents', file), 'utf8'));
    assert.equal(fm.name, file.replace(/\.md$/, ''));
    assert.equal(fm.subagent, 'true');
    assert.equal(fm.mainAgent, 'false');
    assert.ok(fm.description && fm.description.length > 15);
    assert.ok(fm.tools && fm.tools.includes('read_file'));
    assert.equal(fm.model, undefined);
    assert.equal(fm.color, undefined);
  }
});

test('MCP App single-file bundle is built, self-contained, and under 10 MiB', () => {
  const appHtml = fs.readFileSync(path.join(ROOT, 'mcp', 'dist', 'viewer.html'), 'utf8');
  assert.ok(Buffer.byteLength(appHtml, 'utf8') > 10_000);
  assert.ok(Buffer.byteLength(appHtml, 'utf8') < 10 * 1024 * 1024);
  assert.ok(!/<(script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(appHtml));
});
