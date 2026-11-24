import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openArtifact } from '../engine/bin/open-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'engine', 'bin', 'archify.mjs');
const PR_CLI = path.join(ROOT, 'engine', 'bin', 'archify-pr.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-parity-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function runCli(args, { cli = CLI, cwd = ROOT, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1', ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

test('doctor, generate-viewer --check, guide, brands, examples, and demo succeed', () => {
  const viewerCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-viewer.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(viewerCheck.status, 0, viewerCheck.stderr);

  const doctor = runCli(['doctor']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Archify is ready\./);

  const prDoctor = runCli(['doctor'], { cli: PR_CLI });
  assert.equal(prDoctor.status, 0, prDoctor.stderr);

  const guide = runCli(['guide', 'API request sequence with retries', '--json']);
  assert.equal(guide.status, 0, guide.stderr);
  assert.ok(JSON.parse(guide.stdout).ok);

  const brands = runCli(['brands', 'postgres', '--json']);
  assert.equal(brands.status, 0, brands.stderr);
  const brandsJson = JSON.parse(brands.stdout);
  assert.ok(brandsJson.marks?.length > 0);

  const examples = runCli(['examples']);
  assert.equal(examples.status, 0, examples.stderr);
  assert.match(examples.stdout, /web-app-rendered\.html/);

  const demoDir = path.join(TMP, 'demo-out');
  const demo = runCli(['demo', demoDir]);
  assert.equal(demo.status, 0, demo.stderr);
  assert.ok(fs.existsSync(path.join(demoDir, 'archify-demo.html')));
});

test('all 10 native diagram types validate and render cleanly', () => {
  const examples = [
    ['architecture', 'web-app.architecture.json'],
    ['workflow', 'agent-tool-call.workflow.json'],
    ['sequence', 'cache-miss-request.sequence.json'],
    ['dataflow', 'product-analytics.dataflow.json'],
    ['lifecycle', 'agent-run.lifecycle.json'],
    ['erd', 'orders.erd.json'],
    ['class', 'payments.class.json'],
    ['tree', 'payment-platform.tree.json'],
    ['timeline', 'payment-incident.timeline.json'],
    ['waterfall', 'checkout-request.waterfall.json'],
  ];

  const outDir = path.join(TMP, 'all-10');
  fs.mkdirSync(outDir, { recursive: true });

  for (const [type, exampleFile] of examples) {
    const input = path.join(ROOT, 'engine', 'examples', exampleFile);
    const val = runCli(['validate', type, input, '--json']);
    assert.equal(val.status, 0, `validate ${type} failed: ${val.stdout} ${val.stderr}`);
    const htmlOut = path.join(outDir, `${type}.html`);
    const render = runCli(['render', type, input, htmlOut]);
    assert.equal(render.status, 0, `render ${type} failed: ${render.stderr}`);
    const html = fs.readFileSync(htmlOut, 'utf8');
    assert.match(html, /<svg\b/);
  }
});

test('finalize (real Chrome browser-check), inspect, export-svg, and story attachment pass', () => {
  const workDir = path.join(TMP, 'finalize-diagram');
  fs.mkdirSync(workDir, { recursive: true });
  const input = path.join(workDir, 'web-app.json');
  fs.copyFileSync(path.join(ROOT, 'engine', 'examples', 'web-app.architecture.json'), input);

  const inspect = runCli(['inspect', 'architecture', input, '--json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.ok(JSON.parse(inspect.stdout).ok);

  const outHtml = path.join(workDir, 'web-app.html');
  const fin = runCli(['finalize', 'architecture', input, outHtml, '--quality', 'showcase', '--json']);
  assert.equal(fin.status, 0, `finalize failed: ${fin.stdout}\n${fin.stderr}`);
  const receipt = JSON.parse(fin.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.gates['browser-check'], 'pass');

  const svgOut = path.join(workDir, 'web-app.svg');
  const svgRes = runCli(['export-svg', 'architecture', input, svgOut, '--theme', 'dark', '--json']);
  assert.equal(svgRes.status, 0, `export-svg failed: ${svgRes.stdout}\n${svgRes.stderr}`);
  assert.ok(fs.existsSync(svgOut));

  const scan = runCli(['story', 'scan', outHtml, '--json']);
  assert.equal(scan.status, 0, scan.stderr);
  assert.ok(JSON.parse(scan.stdout).nodes?.length > 0);

  const briefPath = path.join(workDir, 'brief.json');
  const draft = runCli(['story', 'draft', outHtml, briefPath, '--json']);
  assert.equal(draft.status, 0, draft.stderr);
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  brief.intro = 'Overview of the web app request path.';
  brief.outro = 'Request lifecycle completes across edge, API, and data store.';
  brief.scenes = brief.scenes.slice(0, 1).map((s) => ({
    ...s,
    points: s.points.slice(0, 1).map((p) => ({
      ...p,
      text: 'Handles incoming application traffic and routes requests cleanly.',
      caption: 'Primary request component handles incoming traffic.',
    })),
  }));
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  const storyHtml = path.join(workDir, 'web-app.story.html');
  const attach = runCli(['story', 'attach', outHtml, briefPath, storyHtml, '--json']);
  assert.equal(attach.status, 0, `story attach failed: ${attach.stdout}\n${attach.stderr}`);
  assert.ok(fs.existsSync(storyHtml));

  const stageHtml = path.join(workDir, 'web-app.stage.html');
  const stage = runCli(['story', 'stage', outHtml, briefPath, stageHtml, '--theme', 'dark', '--json']);
  assert.equal(stage.status, 0, `story stage failed: ${stage.stdout}\n${stage.stderr}`);
  assert.ok(fs.existsSync(stageHtml));
});

test('explainer finalize, panel patch, architecture delta, and workflow migration pass', () => {
  const expDir = path.join(TMP, 'explainer-work');
  fs.mkdirSync(expDir, { recursive: true });
  const expInput = path.join(expDir, 'delivery.explainer.json');
  fs.copyFileSync(path.join(ROOT, 'engine', 'examples', 'delivery.explainer.json'), expInput);
  const expOut = path.join(expDir, 'delivery.html');

  const fin = runCli(['finalize', 'explainer', expInput, expOut, '--json']);
  assert.equal(fin.status, 0, `explainer finalize failed: ${fin.stdout}\n${fin.stderr}`);
  assert.equal(JSON.parse(fin.stdout).ok, true);

  const cmpOut = path.join(TMP, 'delta.html');
  const cmp = runCli([
    'compare',
    'architecture',
    path.join(ROOT, 'engine', 'examples', 'checkout-platform.base.architecture.json'),
    path.join(ROOT, 'engine', 'examples', 'checkout-platform.head.architecture.json'),
    cmpOut,
    '--json',
  ]);
  assert.equal(cmp.status, 0, cmp.stderr);
  assert.ok(fs.existsSync(cmpOut));

  const v1Workflow = path.join(TMP, 'v1.workflow.json');
  fs.writeFileSync(v1Workflow, JSON.stringify({
    schema_version: 1,
    diagram_type: 'workflow',
    meta: { title: 'Simple v1 workflow', output: 'v1.html' },
    lanes: [{ id: 'main', label: 'Main' }],
    nodes: [
      { id: 'start', lane: 'main', col: 0, type: 'external', label: 'Start' },
      { id: 'finish', lane: 'main', col: 1, type: 'backend', label: 'Finish' },
    ],
    edges: [{ from: 'start', to: 'finish', label: 'next' }],
  }, null, 2));
  const v2Workflow = path.join(TMP, 'v2.workflow.json');
  const mig = runCli(['migrate', 'workflow', v1Workflow, v2Workflow, '--to-schema', '2', '--json']);
  assert.equal(mig.status, 0, `migrate failed: ${mig.stdout}\n${mig.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(v2Workflow, 'utf8')).schema_version, 2);
});

test('PR preflight detects Antigravity host & rules and builds PR pack; Code Analysis runs on TS fixture', () => {
  const fakeHome = path.join(TMP, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.gemini', 'config', 'rules'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, '.gemini', 'config', 'rules', 'archify.md'),
    '[archify pr: on-demand, target=comment]\n',
    'utf8',
  );

  const repoDir = path.join(TMP, 'git-repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  const git = (args) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '-b', 'main']).status, 0);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export function run(x: number) { return x + 1; }\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  git(['checkout', '-b', 'feat/change']);
  fs.writeFileSync(path.join(repoDir, 'src', 'helper.ts'), 'export function help(n: number) { return n * 2; }\n', 'utf8');
  fs.writeFileSync(
    path.join(repoDir, 'src', 'app.ts'),
    "import { help } from './helper.js';\nexport function run(x: number) {\n  if (x > 0) return help(x);\n  return 0;\n}\n",
    'utf8',
  );
  git(['add', '.']);
  git(['commit', '-m', 'add helper']);

  const preflight = runCli(['pr', 'preflight', '--repo-root', repoDir, '--base', 'main', '--head', 'HEAD', '--json'], {
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
    },
  });
  assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
  const pf = JSON.parse(preflight.stdout);
  assert.equal(pf.policy.mode, 'on-demand');
  assert.equal(pf.policy.target, 'comment');
  assert.match(pf.policy.source, /archify\.md$/);

  const prWork = path.join(TMP, 'pr-pack');
  fs.mkdirSync(prWork, { recursive: true });
  for (const f of ['checkout-ledger.pr-pack.json', 'checkout-ledger.erd.json', 'checkout-ledger.architecture.json', 'checkout-ledger.sequence.json']) {
    fs.copyFileSync(path.join(ROOT, 'engine', 'examples', f), path.join(prWork, f));
  }
  const prBuildOut = path.join(TMP, 'pr-built');
  const prValidate = runCli(['pr', 'validate', path.join(prWork, 'checkout-ledger.pr-pack.json'), '--json']);
  assert.equal(prValidate.status, 0, prValidate.stdout + prValidate.stderr);
  const prBuild = runCli(['pr', 'build', path.join(prWork, 'checkout-ledger.pr-pack.json'), '--out-dir', prBuildOut, '--no-html', '--json']);
  assert.equal(prBuild.status, 0, prBuild.stdout + prBuild.stderr);
  assert.ok(fs.existsSync(path.join(prBuildOut, 'pr-pack.receipt.json')));
  assert.ok(fs.existsSync(path.join(prBuildOut, 'pr-pack.md')));

  const analysisOut = path.join(TMP, 'analysis-out');
  const caCheck = runCli(['code-analysis', 'check', repoDir, '--language', 'ts', '--fail-on', 'never', '--json']);
  assert.equal(caCheck.status, 0, caCheck.stdout + caCheck.stderr);
  assert.equal(JSON.parse(caCheck.stdout).status, 'ok');

  const caPrepare = runCli(['code-analysis', 'prepare', repoDir, '--language', 'ts', '--out', analysisOut]);
  assert.equal(caPrepare.status, 0, caPrepare.stdout + caPrepare.stderr);
  assert.ok(fs.existsSync(path.join(analysisOut, 'analysis', 'repo.analysis.html')));
});

test('open-artifact delegates cleanly when ARCHIFY_DISABLE_OS_OPEN=1', () => {
  const res = openArtifact(path.join(TMP, 'nonexistent.html'), {
    env: { ARCHIFY_DISABLE_OS_OPEN: '1' },
  });
  assert.equal(res.status, 'delegated');
  assert.equal(res.method, 'antigravity-mcp-app');
});
