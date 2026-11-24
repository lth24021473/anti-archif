/**
 * Antigravity MCP Engine Runner, Artifact Registry & View Payload Extractor.
 *
 * Bridges the upstream Archify v3.3.0 Node engine (engine/) with the Antigravity
 * Stdio MCP server and Archify Studio MCP App without shell interpolation or
 * OS browser popups.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  architectureDeltaChangeRows,
  extractArchitectureSvg,
} from '../engine/delta/architecture-delta.mjs';
import { unpackPageBundle } from '../engine/explainer/page-bundle.mjs';
import {
  BAKE_PRESETS,
  BAKE_THEMES,
  collectSvgRules,
  extractCanonicalSvg,
  loadViewerStyles,
  resolveThemeVariables,
} from '../engine/renderers/shared/svg-bake.mjs';
import { parse, serializeOuter } from '../engine/story/vendor/html-parser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const ENGINE_ROOT = path.join(PLUGIN_ROOT, 'engine');
export const ENGINE_CLI = path.join(ENGINE_ROOT, 'bin', 'archify.mjs');
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_VIEW_PAYLOAD_BYTES = 720 * 1024;
export const MAX_ARTIFACT_HISTORY = 80;

/** Resolve the persistent plugin data directory from CLI args or environment. */
export function resolveDataDir(argv = process.argv.slice(2), env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' && argv[i + 1]) return path.resolve(argv[i + 1]);
    if (arg.startsWith('--data-dir=')) return path.resolve(arg.slice('--data-dir='.length));
  }
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) return path.resolve(env.PLUGIN_DATA);
  if (env.ARCHIFY_MCP_DATA_DIR && env.ARCHIFY_MCP_DATA_DIR.trim()) {
    return path.resolve(env.ARCHIFY_MCP_DATA_DIR);
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugins-data', 'archify');
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Run any Node script inside engine/ asynchronously with bounded output. */
export function runNodeScript(scriptPath, cliArgs = [], options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : PLUGIN_ROOT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = {
    ...process.env,
    ARCHIFY_DISABLE_OS_OPEN: '1',
    ...(process.env.ARCHIFY_AGENT ? {} : { ARCHIFY_AGENT: 'antigravity' }),
    ...(options.env || {}),
  };

  return new Promise((resolve) => {
    const started = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const child = spawn(process.execPath, [scriptPath, ...cliArgs], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        ok: exitCode === 0,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        json: tryParseJson(stdout) ?? tryParseJson(stderr),
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(124, { timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length <= maxBuffer) {
        stdoutChunks.push(chunk);
      }
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes + chunk.length <= maxBuffer) {
        stderrChunks.push(chunk);
      }
      stderrBytes += chunk.length;
    });

    child.on('error', (error) => finish(1, { spawnError: error.message }));
    child.on('close', (code) => finish(code));
  });
}

/** Run the canonical Archify CLI (`engine/bin/archify.mjs`). */
export function runArchifyCli(cliArgs, options = {}) {
  return runNodeScript(ENGINE_CLI, cliArgs, options);
}

/** Run an auxiliary script relative to `engine/` (e.g. `bin/export-svg.mjs`). */
export function runAuxiliaryScript(scriptRelPath, cliArgs = [], options = {}) {
  const resolved = path.resolve(ENGINE_ROOT, scriptRelPath);
  if (!resolved.startsWith(ENGINE_ROOT + path.sep) && resolved !== ENGINE_ROOT) {
    throw new Error(`Invalid auxiliary script path: ${scriptRelPath}`);
  }
  return runNodeScript(resolved, cliArgs, options);
}

/** Manage background preview and Code Analysis HTTP server subprocesses. */
export class PreviewServerManager {
  constructor() {
    this.servers = new Map();
    const cleanup = () => this.stopAll();
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }

  async start(mode, cliArgs, { cwd = PLUGIN_ROOT, env = {}, timeoutMs = 20_000 } = {}) {
    const id = `srv-${randomUUID().slice(0, 8)}`;
    const childEnv = {
      ...process.env,
      ARCHIFY_DISABLE_OS_OPEN: '1',
      ...(process.env.ARCHIFY_AGENT ? {} : { ARCHIFY_AGENT: 'antigravity' }),
      ...env,
    };
    const child = spawn(process.execPath, [ENGINE_CLI, ...cliArgs], {
      cwd: path.resolve(cwd),
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return new Promise((resolve, reject) => {
      let buffer = '';
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill('SIGKILL'); } catch {}
          reject(new Error(`Timed out waiting for ${mode} server URL. Output: ${buffer.slice(-600)}`));
        }
      }, timeoutMs);

      const handleChunk = (chunk) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/?/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          const record = {
            id,
            mode,
            url: match[0],
            pid: child.pid ?? null,
            cwd: path.resolve(cwd),
            args: cliArgs,
            startedAt: new Date().toISOString(),
            child,
          };
          this.servers.set(id, record);
          child.once('exit', () => {
            this.servers.delete(id);
          });
          resolve({
            id: record.id,
            mode: record.mode,
            url: record.url,
            pid: record.pid,
            startedAt: record.startedAt,
          });
        }
      };

      child.stdout.on('data', handleChunk);
      child.stderr.on('data', handleChunk);
      child.once('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once('exit', (code) => {
        this.servers.delete(id);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`${mode} server exited early with code ${code}. Output: ${buffer.slice(-800)}`));
        }
      });
    });
  }

  list() {
    return [...this.servers.values()].map(({ child: _child, ...info }) => info);
  }

  stop(id) {
    const entry = this.servers.get(id);
    if (!entry) return false;
    try { entry.child.kill(); } catch {}
    this.servers.delete(id);
    return true;
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) {
      this.stop(id);
    }
  }
}

/** Persistent artifact and UI preferences store backed by ${PLUGIN_DATA}. */
export class ArtifactStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.artifactsPath = path.join(this.dataDir, 'artifacts.json');
    this.preferencesPath = path.join(this.dataDir, 'preferences.json');
  }

  readAll() {
    const payload = readJsonSafe(this.artifactsPath, { schemaVersion: 1, artifacts: [] });
    return Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  }

  record(entry) {
    if (!entry?.outputPath) return null;
    const outputPath = path.resolve(entry.outputPath);
    const id = entry.id || sha256(outputPath).slice(0, 12);
    const now = new Date().toISOString();
    const list = this.readAll();
    const existingIndex = list.findIndex((item) => item.id === id || path.resolve(item.outputPath) === outputPath);
    const prev = existingIndex >= 0 ? list[existingIndex] : null;
    const normalized = {
      id,
      kind: entry.kind || prev?.kind || 'diagram',
      diagramType: entry.diagramType ?? prev?.diagramType ?? null,
      title: entry.title || prev?.title || path.basename(outputPath),
      outputPath,
      fileUrl: pathToFileURL(outputPath).href,
      inputPath: entry.inputPath ? path.resolve(entry.inputPath) : (prev?.inputPath || null),
      repoRoot: entry.repoRoot ? path.resolve(entry.repoRoot) : (prev?.repoRoot || null),
      ok: entry.ok ?? prev?.ok ?? true,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      receiptSummary: entry.receiptSummary ?? prev?.receiptSummary ?? null,
    };
    const next = existingIndex >= 0
      ? [normalized, ...list.filter((_, idx) => idx !== existingIndex)]
      : [normalized, ...list];
    atomicWriteJson(this.artifactsPath, {
      schemaVersion: 1,
      artifacts: next.slice(0, MAX_ARTIFACT_HISTORY),
    });
    return normalized;
  }

  findByIdOrPath(idOrPath) {
    if (!idOrPath) return null;
    const list = this.readAll();
    const byId = list.find((item) => item.id === idOrPath);
    if (byId) return byId;
    const resolved = path.resolve(idOrPath);
    return list.find((item) => path.resolve(item.outputPath) === resolved) || null;
  }

  scanWorkspace(workspaceDir, { limit = 60 } = {}) {
    if (!workspaceDir) return [];
    const root = path.resolve(workspaceDir);
    const archifyRoot = path.join(root, '.archify');
    if (!fs.existsSync(archifyRoot)) return [];

    const discovered = [];
    const walkDir = (dir, depth) => {
      if (depth > 3 || discovered.length >= limit) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (discovered.length >= limit) break;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name === 'overview.json' && path.basename(dir) === 'analysis') {
          const analysisHtml = path.join(dir, 'repo.analysis.html');
          const target = fs.existsSync(analysisHtml) ? analysisHtml : full;
          const overview = readJsonSafe(full, {});
          discovered.push({
            id: sha256(target).slice(0, 12),
            kind: 'code-analysis',
            diagramType: null,
            title: `Code Analysis (${path.basename(path.dirname(dir))})`,
            outputPath: target,
            fileUrl: pathToFileURL(target).href,
            repoRoot: root,
            ok: true,
            updatedAt: fs.statSync(target).mtime.toISOString(),
            receiptSummary: overview.counts ? { counts: overview.counts, verdict: overview.verdict } : null,
          });
        } else if (entry.name === 'pr-pack.receipt.json') {
          const receipt = readJsonSafe(full, {});
          discovered.push({
            id: sha256(full).slice(0, 12),
            kind: 'pr',
            diagramType: null,
            title: receipt.title || `PR Pack (${path.basename(dir)})`,
            outputPath: full,
            fileUrl: pathToFileURL(full).href,
            repoRoot: root,
            ok: Boolean(receipt.ok ?? true),
            updatedAt: fs.statSync(full).mtime.toISOString(),
            receiptSummary: receipt.stats || null,
          });
        } else if (entry.name.endsWith('.html') && !entry.name.endsWith('.visual-check.html')) {
          const stat = fs.statSync(full);
          const inferredKind = entry.name.endsWith('.stage.html') ? 'story'
            : entry.name.includes('delta') ? 'compare' : 'diagram';
          discovered.push({
            id: sha256(full).slice(0, 12),
            kind: inferredKind,
            diagramType: null,
            title: entry.name.replace(/\.html$/i, ''),
            outputPath: full,
            fileUrl: pathToFileURL(full).href,
            repoRoot: root,
            ok: true,
            updatedAt: stat.mtime.toISOString(),
            receiptSummary: null,
          });
        }
      }
    };

    walkDir(archifyRoot, 0);
    return discovered;
  }

  listCombined(workspaceDir) {
    const merged = new Map();
    for (const item of this.readAll()) {
      if (fs.existsSync(item.outputPath)) {
        merged.set(path.resolve(item.outputPath), item);
      }
    }
    for (const item of this.scanWorkspace(workspaceDir)) {
      const key = path.resolve(item.outputPath);
      if (!merged.has(key)) merged.set(key, item);
    }
    return [...merged.values()]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, MAX_ARTIFACT_HISTORY);
  }

  getPreferences() {
    return readJsonSafe(this.preferencesPath, {
      schemaVersion: 1,
      theme: 'auto',
      preset: null,
      lastWorkspace: null,
    });
  }

  savePreferences(patch = {}) {
    const current = this.getPreferences();
    const next = {
      ...current,
      ...(patch.theme && ['auto', 'light', 'dark'].includes(patch.theme) ? { theme: patch.theme } : {}),
      ...(patch.preset === null || BAKE_PRESETS.includes(patch.preset) ? { preset: patch.preset } : {}),
      ...(typeof patch.lastWorkspace === 'string' || patch.lastWorkspace === null
        ? { lastWorkspace: patch.lastWorkspace } : {}),
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(this.preferencesPath, next);
    return next;
  }
}

/** Generate switchable CSS stylesheet matching Archify Viewer tokens for inline Studio SVGs. */
export function buildScopedSvgThemeCss() {
  const styles = loadViewerStyles();
  const variableBlocks = [];
  for (const preset of BAKE_PRESETS) {
    for (const theme of BAKE_THEMES) {
      const vars = resolveThemeVariables(styles.rules, { theme, preset });
      const entries = [...vars.entries()].map(([k, v]) => `${k}:${v}`).join(';');
      if (preset === 'classic') {
        variableBlocks.push(`.archify-svg-host[data-theme="${theme}"]{${entries}}`);
      }
      variableBlocks.push(`.archify-svg-host[data-preset="${preset}"][data-theme="${theme}"]{${entries}}`);
    }
  }
  const svgRules = collectSvgRules(styles.rules, {
    theme: 'dark',
    preset: 'classic',
    variables: resolveThemeVariables(styles.rules, { theme: 'dark', preset: 'classic' }),
    switchable: true,
  });
  const scopeRule = (rule) => {
    const brace = rule.indexOf('{');
    if (brace === -1) return `.archify-svg-host ${rule}`;
    const prelude = rule.slice(0, brace);
    const body = rule.slice(brace);
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < prelude.length; i += 1) {
      const ch = prelude[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(prelude.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(prelude.slice(start).trim());
    return `${parts.filter(Boolean).map((p) => `.archify-svg-host ${p}`).join(', ')} ${body}`;
  };
  return `${variableBlocks.join('\n')}\n${svgRules.map(scopeRule).join('\n')}`;
}

const attr = (node, key) => node?.attrs?.find((a) => a.name === key)?.value;
const walkNodes = (node) => (node ? [node, ...(node.childNodes || []).flatMap(walkNodes)] : []);
const nodeText = (node) => (node?.childNodes || []).map((c) => c.value || nodeText(c)).join('').trim();

/** Strip active scripts/event handlers/javascript URLs from extracted SVG markup. */
export function sanitizeSvgMarkup(rawSvg) {
  if (!rawSvg || typeof rawSvg !== 'string') return '';
  let clean = rawSvg.replace(/^<\?xml[^>]*\?>\s*/i, '');
  clean = clean.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  clean = clean.replace(/(\b(?:href|xlink:href)\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, '$1#$2');
  if (!/\sxmlns=/.test(clean.slice(0, 500))) {
    clean = clean.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return clean;
}

function extractScriptJson(tree, id) {
  const scriptNode = walkNodes(tree).find(
    (node) => node.tagName === 'script' && attr(node, 'id') === id,
  );
  if (!scriptNode) return null;
  try {
    return JSON.parse(nodeText(scriptNode));
  } catch {
    return null;
  }
}

function extractDiagramSemantics(svgString, tree) {
  const svgTree = parse(svgString);
  const elements = walkNodes(svgTree);
  const rootSvg = elements.find((node) => node.tagName === 'svg');
  const evidence = tree ? extractScriptJson(tree, 'archify-source-evidence-data') : null;
  const explanations = tree ? extractScriptJson(tree, 'archify-explanations-data') : null;
  const payloads = tree ? extractScriptJson(tree, 'archify-payloads-data') : null;

  const edgeMap = new Map();
  for (const el of elements.filter((n) => attr(n, 'data-edge-from') && attr(n, 'data-edge-to'))) {
    const id = attr(el, 'data-edge-id') || attr(el, 'data-edge-key') || `${attr(el, 'data-edge-from')}~${attr(el, 'data-edge-to')}`;
    const prev = edgeMap.get(id) || {};
    edgeMap.set(id, {
      id,
      from: attr(el, 'data-edge-from'),
      to: attr(el, 'data-edge-to'),
      label: attr(el, 'data-edge-label') || prev.label || '',
      kind: attr(el, 'data-class-relationship') || attr(el, 'data-er-ends') || prev.kind || null,
    });
  }
  const edges = [...edgeMap.values()];

  const nodes = [];
  const seenNodes = new Set();
  for (const el of elements.filter((n) => attr(n, 'data-node-id'))) {
    const id = attr(el, 'data-node-id');
    if (seenNodes.has(id)) continue;
    seenNodes.add(id);
    let drilldowns = [];
    const rawDrill = attr(el, 'data-drilldowns');
    if (rawDrill) {
      try {
        const parsed = JSON.parse(rawDrill);
        if (Array.isArray(parsed)) drilldowns = parsed;
      } catch {}
    }
    if (!drilldowns.length) {
      const link = walkNodes(el).find((n) => n.tagName === 'a' && attr(n, 'href'));
      if (link) drilldowns = [{ label: attr(el, 'data-node-label') || id, href: attr(link, 'href') }];
    }
    const sources = evidence?.verified === true ? (evidence.nodes?.[id] || []) : [];
    const explanation = explanations?.[id] || attr(el, 'data-explanation') || null;
    nodes.push({
      id,
      label: attr(el, 'data-node-label') || id,
      kind: attr(el, 'data-node-kind') || 'component',
      sublabel: attr(el, 'data-node-sublabel') || '',
      tag: attr(el, 'data-node-tag') || '',
      context: attr(el, 'data-node-context') || '',
      explanation,
      payload: payloads?.[id] || null,
      sources,
      drilldowns,
      incoming: edges.filter((e) => e.to === id).map((e) => ({ id: e.id, from: e.from, label: e.label })),
      outgoing: edges.filter((e) => e.from === id).map((e) => ({ id: e.id, to: e.to, label: e.label })),
    });
  }

  const diagramType =
    attr(rootSvg, 'data-diagram-type')
    || ['class', 'tree', 'timeline', 'waterfall'].find((t) => attr(rootSvg, `data-${t}-ui`) !== undefined)
    || (attr(rootSvg, 'data-erd-ui') !== undefined ? 'erd' : null)
    || (attr(rootSvg, 'data-sequence-column-fit') !== undefined ? 'sequence' : null)
    || (attr(rootSvg, 'data-lifecycle-ui') !== undefined ? 'lifecycle' : null)
    || (attr(rootSvg, 'data-dataflow-ui') !== undefined ? 'dataflow' : null)
    || (attr(rootSvg, 'data-workflow-ui') !== undefined ? 'workflow' : null)
    || 'architecture';

  return {
    diagramType,
    preset: attr(rootSvg, 'data-preset') || 'classic',
    qualityProfile: attr(rootSvg, 'data-quality-profile') || 'standard',
    viewBox: attr(rootSvg, 'viewBox') || null,
    parentHref: attr(rootSvg, 'data-parent-href') || null,
    repository: evidence?.verified === true ? evidence.repository : null,
    nodes,
    edges,
  };
}

function readSiblingReceipts(artifactPath) {
  const dir = path.dirname(artifactPath);
  const stem = path.basename(artifactPath, path.extname(artifactPath));
  const summaryCandidates = [
    path.join(dir, `${stem}.finalize-summary.json`),
    path.join(dir, `${stem}.finalize.json`),
  ];
  let summary = null;
  for (const file of summaryCandidates) {
    if (fs.existsSync(file)) {
      summary = readJsonSafe(file);
      if (summary) break;
    }
  }
  return { summary };
}

function detectArtifactKind(targetPath, hintKind = null) {
  if (hintKind) return hintKind;
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    if (fs.existsSync(path.join(resolved, 'analysis', 'overview.json')) || fs.existsSync(path.join(resolved, 'overview.json'))) {
      return 'code-analysis';
    }
    if (fs.existsSync(path.join(resolved, 'pr-pack.receipt.json'))) return 'pr';
  }
  const base = path.basename(resolved).toLowerCase();
  if (base === 'pr-pack.receipt.json' || base === 'pr-pack.md') return 'pr';
  if (base === 'repo.analysis.html' || base === 'overview.json' || base === 'findings.json') return 'code-analysis';
  if (base.endsWith('.stage.html') || base.endsWith('.mp4') || base.endsWith('.webm')) return 'story';
  if (base.endsWith('.svg')) {
    const raw = fs.readFileSync(resolved, 'utf8');
    return /data-story|archify-story/.test(raw) ? 'story' : 'diagram';
  }
  if (base.endsWith('.html')) {
    const html = fs.readFileSync(resolved, 'utf8');
    if (html.includes('data-archify-artifact="explainer"') || html.includes('id="archify-explainer-prepared"')) {
      return 'explainer';
    }
    if (html.includes('id="archify-compare-receipt"')) return 'compare';
    if (html.includes('id="story-stage-meta"')) return 'story';
    if (html.includes('id="archify-story-payload"')) return 'story';
    if (html.includes('data-analysis-mode="standalone"') || html.includes('id="bauify-atlas"')) {
      return 'code-analysis';
    }
    return 'diagram';
  }
  return 'diagram';
}

function clampPayload(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes <= MAX_VIEW_PAYLOAD_BYTES) return payload;
  const copy = { ...payload, truncated: true, originalBytes: bytes };
  if (Array.isArray(copy.findings) && copy.findings.length > 60) {
    copy.findings = copy.findings.slice(0, 60);
  }
  if (Array.isArray(copy.edges) && copy.edges.length > 150) {
    copy.edges = copy.edges.slice(0, 150);
  }
  if (typeof copy.markdown === 'string' && copy.markdown.length > 24_000) {
    copy.markdown = `${copy.markdown.slice(0, 24_000)}\n\n…(truncated)`;
  }
  return copy;
}

/**
 * Extract clean, CSP-safe, render-ready data for Archify Studio from any
 * generated HTML, SVG, PR Pack, or Code Analysis output directory.
 */
export function extractArtifactViewPayload(targetPath, { kind = null, repoRoot = null } = {}) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  const detectedKind = detectArtifactKind(resolved, kind);
  const fileUrl = pathToFileURL(resolved).href;

  if (detectedKind === 'code-analysis') {
    const stat = fs.statSync(resolved);
    let analysisDir;
    if (stat.isDirectory()) {
      analysisDir = fs.existsSync(path.join(resolved, 'analysis', 'overview.json'))
        ? path.join(resolved, 'analysis') : resolved;
    } else if (path.basename(resolved) === 'repo.analysis.html' || path.basename(resolved) === 'overview.json' || path.basename(resolved) === 'findings.json') {
      analysisDir = path.dirname(resolved);
    } else {
      analysisDir = path.join(path.dirname(resolved), 'analysis');
    }
    const overview = readJsonSafe(path.join(analysisDir, 'overview.json'), {});
    const findingsDoc = readJsonSafe(path.join(analysisDir, 'findings.json'), {});
    const graphDoc = readJsonSafe(path.join(analysisDir, 'module-graph.json'), {});
    const htmlPath = fs.existsSync(path.join(analysisDir, 'repo.analysis.html'))
      ? path.join(analysisDir, 'repo.analysis.html') : resolved;

    const modules = (graphDoc.modules || []).slice(0, 80).map((m) => ({
      id: m.id,
      label: m.label,
      path: m.path,
      files: m.files,
      loc: m.loc,
      fanIn: m.fanIn,
      fanOut: m.fanOut,
      instability: m.instability,
      entry: m.entry || [],
    }));
    const modSet = new Set(modules.map((m) => m.id));
    const moduleEdges = (graphDoc.edges || [])
      .filter((e) => modSet.has(e.from) && modSet.has(e.to))
      .slice(0, 220)
      .map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
    const findings = (findingsDoc.diagnostics || []).slice(0, 120).map((f) => ({
      id: f.id,
      code: f.code,
      dimension: f.dimension,
      severity: f.severity,
      confidence: f.confidence,
      message: f.message,
      subject: f.subject,
      supportedFixes: f.supportedFixes || [],
    }));

    return clampPayload({
      kind: 'code-analysis',
      title: `Code Analysis · ${path.basename(graphDoc.repository?.root || repoRoot || path.dirname(analysisDir))}`,
      artifactPath: htmlPath,
      analysisDir,
      fileUrl: pathToFileURL(htmlPath).href,
      repoRoot: graphDoc.repository?.root || repoRoot || null,
      verdict: overview.verdict || 'unknown',
      counts: overview.counts || findingsDoc.summary || {},
      coverage: overview.coverage || findingsDoc.analysis?.coverage || {},
      priorities: overview.priorities || [],
      investigation: overview.investigation || {},
      modules,
      moduleEdges,
      findings,
    });
  }

  if (detectedKind === 'pr') {
    const isDir = fs.statSync(resolved).isDirectory();
    const prDir = isDir ? resolved : path.dirname(resolved);
    const receiptPath = path.basename(resolved) === 'pr-pack.receipt.json'
      ? resolved : path.join(prDir, 'pr-pack.receipt.json');
    const receipt = readJsonSafe(receiptPath, {});
    const mdPath = path.join(prDir, 'pr-pack.md');
    const markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    const svgs = [];
    const collectSvgs = (dir, depth = 0) => {
      if (depth > 2 || svgs.length >= 8) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectSvgs(full, depth + 1);
        else if (entry.name.endsWith('.svg')) {
          svgs.push({
            name: path.relative(prDir, full).replace(/\\/g, '/'),
            path: full,
            svg: sanitizeSvgMarkup(fs.readFileSync(full, 'utf8')),
          });
        }
      }
    };
    collectSvgs(prDir);

    return clampPayload({
      kind: 'pr',
      title: receipt.title || 'Archify PR Visual Pack',
      artifactPath: receiptPath,
      fileUrl: pathToFileURL(receiptPath).href,
      repoRoot: receipt.repoRoot || repoRoot || null,
      receipt,
      markdown,
      svgs,
    });
  }

  const rawText = fs.readFileSync(resolved, 'utf8');

  if (resolved.toLowerCase().endsWith('.svg')) {
    const svg = sanitizeSvgMarkup(rawText);
    const semantics = extractDiagramSemantics(svg, null);
    return clampPayload({
      kind: detectedKind === 'story' ? 'story' : 'diagram',
      title: path.basename(resolved, '.svg'),
      subtitle: '',
      artifactPath: resolved,
      fileUrl,
      repoRoot,
      svg,
      ...semantics,
    });
  }

  const tree = parse(rawText);

  if (detectedKind === 'explainer') {
    const packed = extractScriptJson(tree, 'archify-explainer-prepared');
    const bundle = packed ? unpackPageBundle(packed) : null;
    const manifest = extractScriptJson(tree, 'explainer-manifest') || {};
    const doc = bundle?.document || {};
    const preparedDiagrams = bundle?.preparedDiagrams?.diagrams || {};
    const embeddedDiagrams = Object.fromEntries(
      Object.entries(preparedDiagrams).map(([id, entry]) => [
        id,
        {
          diagramType: entry.diagramType,
          svg: entry.svg ? sanitizeSvgMarkup(entry.svg) : '',
          semantic: entry.semantic || null,
        },
      ]),
    );
    const titleEl = walkNodes(tree).find((n) => n.tagName === 'h1') || walkNodes(tree).find((n) => n.tagName === 'title');
    const panelSections = walkNodes(tree).filter((n) => n.tagName === 'section' && attr(n, 'class')?.includes('panel') && !attr(n, 'id')?.includes('answer'));
    const renderedPanels = panelSections.map((section) => {
      const id = attr(section, 'id');
      const heading = attr(section, 'data-title') || nodeText(walkNodes(section).find((n) => n.tagName === 'h2'));
      const charts = walkNodes(section)
        .filter((n) => n.tagName === 'figure' && attr(n, 'class')?.includes('chart'))
        .map((fig) => {
          const svgNode = walkNodes(fig).find((n) => n.tagName === 'svg');
          return svgNode ? sanitizeSvgMarkup(serializeOuter(svgNode)) : null;
        })
        .filter(Boolean);
      const specPanel = (doc.panels || []).find((p) => p.id === id) || null;
      return {
        id,
        title: heading || specPanel?.title || id,
        blocks: specPanel?.blocks || [],
        charts,
      };
    });

    return clampPayload({
      kind: 'explainer',
      title: doc.meta?.title || nodeText(titleEl) || path.basename(resolved),
      locale: doc.meta?.locale || 'en',
      style: doc.meta?.style || attr(walkNodes(tree).find((n) => n.tagName === 'html'), 'data-style') || 'clean',
      artifactPath: resolved,
      fileUrl,
      repoRoot,
      answer: doc.answer || null,
      panels: renderedPanels,
      diagrams: embeddedDiagrams,
      sources: bundle?.preparedSources?.sources || doc.sources || [],
      manifest,
      ...readSiblingReceipts(resolved),
    });
  }

  if (detectedKind === 'compare') {
    const receipt = extractScriptJson(tree, 'archify-compare-receipt') || {};
    const deltaSection = walkNodes(tree).find((n) => n.tagName === 'section' && attr(n, 'data-view') === 'delta');
    const baseSection = walkNodes(tree).find((n) => n.tagName === 'section' && attr(n, 'data-view') === 'base');
    const headSection = walkNodes(tree).find((n) => n.tagName === 'section' && attr(n, 'data-view') === 'head');
    const extractSectionSvg = (section) => {
      if (!section) return '';
      const directSvg = walkNodes(section).find((n) => n.tagName === 'svg');
      if (directSvg) return sanitizeSvgMarkup(serializeOuter(directSvg));
      const frame = walkNodes(section).find((n) => n.tagName === 'iframe' && attr(n, 'srcdoc'));
      if (frame) {
        try {
          return sanitizeSvgMarkup(extractCanonicalSvg(attr(frame, 'srcdoc')));
        } catch {
          return '';
        }
      }
      return '';
    };
    let deltaSvg = '';
    try {
      deltaSvg = sanitizeSvgMarkup(extractArchitectureSvg(rawText));
    } catch {
      deltaSvg = extractSectionSvg(deltaSection);
    }
    return clampPayload({
      kind: 'compare',
      title: receipt.head?.title ? `${receipt.base?.title || 'Base'} -> ${receipt.head.title}` : 'Architecture Delta',
      artifactPath: resolved,
      fileUrl,
      repoRoot,
      receipt,
      changeRows: receipt.changes ? architectureDeltaChangeRows(receipt) : [],
      deltaSvg,
      baseSvg: extractSectionSvg(baseSection),
      headSvg: extractSectionSvg(headSection),
      ...readSiblingReceipts(resolved),
    });
  }

  if (detectedKind === 'story') {
    const stageMeta = extractScriptJson(tree, 'story-stage-meta');
    if (stageMeta) {
      const panes = walkNodes(tree)
        .filter((n) => n.tagName === 'div' && attr(n, 'class')?.includes('stage-pane'))
        .map((pane) => {
          const svgNode = walkNodes(pane).find((n) => n.tagName === 'svg');
          return {
            theme: attr(pane, 'data-stage-theme') || 'switchable',
            svg: svgNode ? sanitizeSvgMarkup(serializeOuter(svgNode)) : '',
          };
        });
      return clampPayload({
        kind: 'story',
        storyKind: 'stage',
        title: stageMeta.title || 'Archify Story Stage',
        artifactPath: resolved,
        fileUrl,
        repoRoot,
        duration: stageMeta.duration,
        preset: stageMeta.preset || 'classic',
        defaultTheme: stageMeta.defaultTheme || 'light',
        steps: stageMeta.steps || [],
        panes,
      });
    }

    const storyPayload = extractScriptJson(tree, 'archify-story-payload');
    const canonicalSvg = sanitizeSvgMarkup(extractCanonicalSvg(rawText));
    const semantics = extractDiagramSemantics(canonicalSvg, tree);
    let storyPlan = null;
    if (storyPayload?.html) {
      try {
        const innerHtml = Buffer.from(storyPayload.html, 'base64').toString('utf8');
        const innerTree = parse(innerHtml);
        storyPlan = extractScriptJson(innerTree, 'story-data');
      } catch {}
    }
    return clampPayload({
      kind: 'story',
      storyKind: 'attached',
      title: storyPlan?.plan?.title || semantics.diagramType || path.basename(resolved),
      artifactPath: resolved,
      fileUrl,
      repoRoot,
      svg: canonicalSvg,
      ...semantics,
      storyPlan: storyPlan?.plan || null,
      ...readSiblingReceipts(resolved),
    });
  }

  // Default: Native Diagram HTML
  const canonicalSvg = sanitizeSvgMarkup(extractCanonicalSvg(rawText));
  const semantics = extractDiagramSemantics(canonicalSvg, tree);
  const headerTitle = walkNodes(tree).find((n) => n.tagName === 'h1');
  const subtitleEl = walkNodes(tree).find((n) => n.tagName === 'p' && attr(n, 'class') === 'subtitle');
  return clampPayload({
    kind: 'diagram',
    title: nodeText(headerTitle) || path.basename(resolved, '.html'),
    subtitle: nodeText(subtitleEl) || '',
    artifactPath: resolved,
    fileUrl,
    repoRoot: semantics.repository?.root || repoRoot || null,
    svg: canonicalSvg,
    ...semantics,
    ...readSiblingReceipts(resolved),
  });
}
