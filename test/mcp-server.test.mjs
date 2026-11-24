import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-mcp-test-'));
const DATA_DIR = path.join(TMP, 'plugin-data');

let client;
let transport;

before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs'), '--data-dir', DATA_DIR],
    cwd: ROOT,
    env: {
      ...process.env,
      ARCHIFY_UPDATE_CHECK_DISABLED: '1',
    },
  });
  client = new Client({ name: 'archify-parity-suite', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  try {
    await transport?.close();
  } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('lists 8 model tools + 4 app-only tools and serves ui://archify/viewer.html', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    'archify_studio',
    'archify_guide_and_catalog',
    'archify_diagram',
    'archify_explainer',
    'archify_compare',
    'archify_story',
    'archify_pr',
    'archify_code_analysis',
    'app_list_artifacts',
    'app_load_artifact',
    'app_export_artifact',
    'app_save_preferences',
  ]) {
    assert.ok(names.includes(expected), `Missing MCP tool: ${expected}`);
  }

  const studio = tools.find((t) => t.name === 'archify_studio');
  assert.equal(studio._meta?.ui?.resourceUri, 'ui://archify/viewer.html');
  assert.ok(Array.isArray(studio._meta?.['com.google.antigravity/ui']?.entrypoints));
  assert.equal(studio._meta['com.google.antigravity/ui'].entrypoints.length, 2);

  for (const appOnlyName of ['app_list_artifacts', 'app_load_artifact', 'app_export_artifact', 'app_save_preferences']) {
    const tool = tools.find((t) => t.name === appOnlyName);
    assert.deepEqual(tool._meta?.ui?.visibility, ['app']);
  }

  const { resources } = await client.listResources();
  const viewerRes = resources.find((r) => r.uri === 'ui://archify/viewer.html');
  assert.ok(viewerRes);
  assert.equal(viewerRes.mimeType, 'text/html;profile=mcp-app');

  const read = await client.readResource({ uri: 'ui://archify/viewer.html' });
  assert.ok(read.contents[0].text.includes('Archify Studio'));
});

test('guide/catalog, diagram finalize, story attach, explainer, compare, code analysis, and Studio app tools work end-to-end', async () => {
  const guideRes = await client.callTool({
    name: 'archify_guide_and_catalog',
    arguments: { action: 'guide', query: 'SQL database foreign key schema' },
  });
  assert.equal(guideRes.isError ?? false, false);
  assert.equal(guideRes.structuredContent.ok, true);

  const schemaRes = await client.callTool({
    name: 'archify_guide_and_catalog',
    arguments: { action: 'schema', schemaType: 'erd' },
  });
  assert.equal(schemaRes.isError ?? false, false);
  assert.match(String(schemaRes.structuredContent.schema.$id), /erd\.schema\.json$/);

  // 1. Diagram finalize (real Chrome browser-check)
  const diagDir = path.join(TMP, 'diag');
  fs.mkdirSync(diagDir, { recursive: true });
  const diagIn = path.join(diagDir, 'web-app.json');
  fs.copyFileSync(path.join(ROOT, 'engine', 'examples', 'web-app.architecture.json'), diagIn);
  const diagOut = path.join(diagDir, 'web-app.html');
  const diagRes = await client.callTool({
    name: 'archify_diagram',
    arguments: {
      action: 'finalize',
      type: 'architecture',
      inputPath: diagIn,
      outputPath: diagOut,
      quality: 'showcase',
    },
  });
  assert.equal(diagRes.isError ?? false, false, JSON.stringify(diagRes));
  assert.equal(diagRes.structuredContent.ok, true);
  assert.ok(diagRes.structuredContent.artifactId);

  // Load diagram payload via app_load_artifact
  const loadedDiag = await client.callTool({
    name: 'app_load_artifact',
    arguments: { artifactId: diagRes.structuredContent.artifactId },
  });
  assert.equal(loadedDiag.structuredContent.kind, 'diagram');
  assert.match(loadedDiag.structuredContent.svg, /<svg\b/);
  assert.ok(loadedDiag.structuredContent.nodes.length > 0);

  // 2. Explainer finalize + load
  const expDir = path.join(TMP, 'exp');
  fs.mkdirSync(expDir, { recursive: true });
  const expIn = path.join(expDir, 'delivery.explainer.json');
  fs.copyFileSync(path.join(ROOT, 'engine', 'examples', 'delivery.explainer.json'), expIn);
  const expOut = path.join(expDir, 'delivery.html');
  const expRes = await client.callTool({
    name: 'archify_explainer',
    arguments: { action: 'finalize', inputPath: expIn, outputPath: expOut },
  });
  assert.equal(expRes.isError ?? false, false, JSON.stringify(expRes));
  const loadedExp = await client.callTool({
    name: 'app_load_artifact',
    arguments: { artifactPath: expOut },
  });
  assert.equal(loadedExp.structuredContent.kind, 'explainer');
  assert.ok(loadedExp.structuredContent.panels.length > 0);

  // 3. Compare architecture + load
  const cmpOut = path.join(TMP, 'delta.html');
  const cmpRes = await client.callTool({
    name: 'archify_compare',
    arguments: {
      basePath: path.join(ROOT, 'engine', 'examples', 'checkout-platform.base.architecture.json'),
      headPath: path.join(ROOT, 'engine', 'examples', 'checkout-platform.head.architecture.json'),
      outputPath: cmpOut,
    },
  });
  assert.equal(cmpRes.isError ?? false, false, JSON.stringify(cmpRes));
  const loadedCmp = await client.callTool({
    name: 'app_load_artifact',
    arguments: { artifactPath: cmpOut },
  });
  assert.equal(loadedCmp.structuredContent.kind, 'compare');
  assert.match(loadedCmp.structuredContent.deltaSvg, /<svg\b/);

  // 4. Story scan
  const scanRes = await client.callTool({
    name: 'archify_story',
    arguments: { action: 'scan', nativeHtmlPath: diagOut },
  });
  assert.equal(scanRes.isError ?? false, false);
  assert.ok(scanRes.structuredContent.nodes.length > 0);

  // 5. Code Analysis prepare + load
  const tsRepo = path.join(TMP, 'ts-repo');
  fs.mkdirSync(path.join(tsRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tsRepo, 'src', 'a.ts'), "import { b } from './b.js';\nexport const a = () => b();\n");
  fs.writeFileSync(path.join(tsRepo, 'src', 'b.ts'), "export const b = () => 42;\n");
  const caOut = path.join(TMP, 'ca-out');
  const caRes = await client.callTool({
    name: 'archify_code_analysis',
    arguments: { action: 'prepare', repoRoot: tsRepo, outDir: caOut, language: 'ts' },
  });
  assert.equal(caRes.isError ?? false, false, JSON.stringify(caRes));
  const loadedCa = await client.callTool({
    name: 'app_load_artifact',
    arguments: { artifactPath: path.join(caOut, 'analysis', 'repo.analysis.html') },
  });
  assert.equal(loadedCa.structuredContent.kind, 'code-analysis');
  assert.ok(Array.isArray(loadedCa.structuredContent.modules));

  // 6. PR preflight
  const git = (args) => spawnSync('git', ['-C', tsRepo, ...args], { encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  const prRes = await client.callTool({
    name: 'archify_pr',
    arguments: { action: 'preflight', repoRoot: tsRepo, base: 'main', head: 'HEAD' },
  });
  assert.equal(prRes.isError ?? false, false, JSON.stringify(prRes));
  assert.equal(prRes.structuredContent.ok, true);

  // 7. Entrypoint archify_studio {} + app_list_artifacts + app_save_preferences
  const studioEmpty = await client.callTool({ name: 'archify_studio', arguments: {} });
  assert.equal(studioEmpty.isError ?? false, false);
  assert.ok(studioEmpty.structuredContent.artifacts.length >= 4);

  const listApp = await client.callTool({ name: 'app_list_artifacts', arguments: {} });
  assert.ok(listApp.structuredContent.artifacts.length >= 4);

  const prefsRes = await client.callTool({
    name: 'app_save_preferences',
    arguments: { theme: 'light', preset: 'blueprint' },
  });
  assert.equal(prefsRes.structuredContent.preferences.theme, 'light');
  assert.equal(prefsRes.structuredContent.preferences.preset, 'blueprint');
});
