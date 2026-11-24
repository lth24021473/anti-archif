#!/usr/bin/env node
/**
 * Antigravity Stdio MCP Server for Archify v3.3.0.
 *
 * Exposes 100% of Archify's deterministic engine capabilities (10 native
 * diagram types, one-page explainers, architecture deltas, stories/videos,
 * PR visual packs, and multi-language Code Analysis) together with the
 * interactive Archify Studio MCP App UI (`ui://archify/viewer.html`).
 *
 * IMPORTANT: Never write non-protocol output to process.stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  ArtifactStore,
  ENGINE_ROOT,
  PLUGIN_ROOT,
  PreviewServerManager,
  extractArtifactViewPayload,
  resolveDataDir,
  runArchifyCli,
  runAuxiliaryScript,
} from './runner.mjs';

const APP_URI = 'ui://archify/viewer.html';
const DIAGRAM_TYPES = [
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
  'erd',
  'class',
  'tree',
  'timeline',
  'waterfall',
];
const ALL_SCHEMA_TYPES = [
  ...DIAGRAM_TYPES,
  'explainer',
  'common',
  'pr-pack',
  'story-choreography',
];

const dataDir = resolveDataDir();
const store = new ArtifactStore(dataDir);
const servers = new PreviewServerManager();

function readAppHtml() {
  const override = process.env.ARCHIFY_APP_HTML;
  const htmlPath = override && override.trim()
    ? path.resolve(override)
    : path.join(PLUGIN_ROOT, 'mcp', 'dist', 'viewer.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

function resolveMaybePath(target, cwd) {
  if (!target) return null;
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd || process.cwd(), target);
}

function extractPathField(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.path === 'string') return value.path;
  return null;
}

function compactCliOutcome(commandLabel, res, extra = {}) {
  const payload = res.json && typeof res.json === 'object' ? res.json : null;
  const ok = Boolean(res.ok && (payload?.ok ?? true));
  const structured = {
    ok,
    command: commandLabel,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    ...(payload || {}),
    ...extra,
  };
  const summaryText = payload?.error
    || (ok
      ? `${commandLabel} succeeded${structured.artifactPath ? ` -> ${structured.artifactPath}` : ''}.`
      : `${commandLabel} failed (exit ${res.exitCode}): ${(res.stderr || res.stdout || 'unknown error').trim().slice(0, 600)}`);
  return {
    isError: !ok,
    content: [{ type: 'text', text: summaryText }],
    structuredContent: structured,
  };
}

function recordIfExists({ kind, diagramType = null, title, outputPath, inputPath = null, repoRoot = null, ok = true, receiptSummary = null }) {
  if (!outputPath || !fs.existsSync(outputPath)) return null;
  return store.record({
    kind,
    diagramType,
    title,
    outputPath,
    inputPath,
    repoRoot,
    ok,
    receiptSummary,
  });
}

function buildServer() {
  const server = new McpServer({
    name: 'archify',
    version: '3.3.0',
  });

  registerAppResource(
    server,
    'Archify Studio',
    APP_URI,
    {
      description: 'Interactive Archify Studio UI for native diagrams, explainers, deltas, stories, PR packs, and Code Analysis.',
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readAppHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  // 1. Entrypoint tool for inline, side-pane, and sidebar global Studio views
  registerAppTool(
    server,
    'archify_studio',
    {
      title: 'Archify Studio',
      description: 'Open or refresh an Archify diagram, explainer, architecture delta, story, PR visual pack, or Code Analysis report inside Archify Studio (or browse workspace artifacts when called with {}).',
      inputSchema: {
        artifactPath: z.string().optional().describe('Optional path to an Archify HTML, SVG, PR pack, or Code Analysis directory.'),
        workspaceDir: z.string().optional().describe('Optional workspace root to scan for .archify/ artifacts.'),
        kind: z.enum(['diagram', 'explainer', 'compare', 'story', 'pr', 'code-analysis']).optional().describe('Optional explicit artifact kind.'),
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Archify Studio' },
            { type: 'global', title: 'Archify Studio' },
          ],
        },
      },
    },
    async ({ artifactPath, workspaceDir, kind }) => {
      const ws = workspaceDir ? resolveMaybePath(workspaceDir, process.cwd()) : null;
      if (ws) store.savePreferences({ lastWorkspace: ws });
      const resolved = artifactPath ? resolveMaybePath(artifactPath, ws || process.cwd()) : null;

      if (resolved) {
        if (!fs.existsSync(resolved)) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Artifact not found: ${resolved}` }],
            structuredContent: { ok: false, error: `Artifact not found: ${resolved}` },
          };
        }
        const entry = recordIfExists({
          kind: kind || undefined,
          title: path.basename(resolved),
          outputPath: resolved,
          repoRoot: ws,
        });
        return {
          content: [{ type: 'text', text: `Opened ${resolved} in Archify Studio.` }],
          structuredContent: {
            ok: true,
            artifactPath: resolved,
            fileUrl: pathToFileURL(resolved).href,
            kind: entry?.kind || kind || null,
            artifactId: entry?.id || null,
          },
        };
      }

      const artifacts = store.listCombined(ws || store.getPreferences().lastWorkspace || process.cwd());
      return {
        content: [{ type: 'text', text: `Archify Studio ready (${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} indexed).` }],
        structuredContent: {
          ok: true,
          artifacts,
        },
      };
    },
  );

  // 2. Guide, Brand Marks, Examples, Schemas, Doctor, Demo, Update preferences
  server.registerTool(
    'archify_guide_and_catalog',
    {
      title: 'Archify Guide & Catalog',
      description: 'Query Archify scenario guide, built-in brand marks, external brand URL capture, showcase examples, JSON schemas, setup doctor, demo generation, or update reminder preferences.',
      inputSchema: {
        action: z.enum([
          'guide',
          'brands_search',
          'brands_capture',
          'examples',
          'schema',
          'doctor',
          'demo',
          'update_preference',
        ]),
        query: z.string().optional().describe('Scenario question or brand search query.'),
        lang: z.enum(['en', 'zh']).optional(),
        url: z.string().optional().describe('Explicit brand website URL for brands_capture.'),
        schemaType: z.enum(ALL_SCHEMA_TYPES).optional().describe('Schema name for action="schema".'),
        outputDir: z.string().optional().describe('Output directory for action="demo".'),
        updateAction: z.enum(['snooze', 'ignore']).optional().describe('For action="update_preference".'),
        eventKey: z.string().optional().describe('Receipt update.eventKey for action="update_preference".'),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const cwd = args.cwd || PLUGIN_ROOT;
      if (args.action === 'schema') {
        const schemaName = args.schemaType || 'architecture';
        const schemaPath = path.join(ENGINE_ROOT, 'schemas', `${schemaName}.schema.json`);
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        return {
          content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
          structuredContent: { ok: true, schemaType: schemaName, schemaPath, schema },
        };
      }

      if (args.action === 'update_preference') {
        if (!args.updateAction || !args.eventKey) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'update_preference requires both updateAction and eventKey.' }],
            structuredContent: { ok: false, error: 'Missing updateAction or eventKey.' },
          };
        }
        const flag = args.updateAction === 'ignore' ? '--ignore' : '--snooze';
        const res = await runAuxiliaryScript('scripts/check-update.mjs', [flag, args.eventKey], { cwd });
        return compactCliOutcome(`check-update ${flag}`, res);
      }

      let cliArgs = [];
      if (args.action === 'guide') {
        cliArgs = ['guide', ...(args.query ? [args.query] : []), ...(args.lang ? ['--lang', args.lang] : []), '--json'];
      } else if (args.action === 'brands_search') {
        cliArgs = ['brands', ...(args.query ? [args.query] : []), '--json'];
      } else if (args.action === 'brands_capture') {
        if (!args.url) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'brands_capture requires url.' }],
            structuredContent: { ok: false, error: 'Missing url.' },
          };
        }
        cliArgs = ['brands', 'capture', args.url, '--json'];
      } else if (args.action === 'examples') {
        cliArgs = ['examples'];
      } else if (args.action === 'doctor') {
        cliArgs = ['doctor'];
      } else if (args.action === 'demo') {
        cliArgs = ['demo', ...(args.outputDir ? [resolveMaybePath(args.outputDir, cwd)] : [])];
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      if (res.json) return compactCliOutcome(args.action, res);
      return {
        isError: !res.ok,
        content: [{ type: 'text', text: (res.stdout || res.stderr || '').trim() }],
        structuredContent: {
          ok: res.ok,
          command: args.action,
          exitCode: res.exitCode,
          output: (res.stdout || '').trim(),
          stderr: (res.stderr || '').trim(),
        },
      };
    },
  );

  // 3. Native Diagrams (10 types): finalize, validate, inspect, render, deliver, check, browser-check, visual-check, export-svg, migrate, recover-output
  registerAppTool(
    server,
    'archify_diagram',
    {
      title: 'Archify Diagram Engine',
      description: 'Validate, inspect, render, deliver, finalize (validate+deliver+check+browser-check), check, export SVG, migrate workflow v1->v2, or recover output for all 10 Archify diagram types.',
      inputSchema: {
        action: z.enum([
          'finalize',
          'validate',
          'inspect',
          'render',
          'deliver',
          'check',
          'browser-check',
          'visual-check',
          'export-svg',
          'migrate',
          'recover-output',
        ]),
        type: z.enum(DIAGRAM_TYPES).optional().describe('Required for diagram actions except check/browser-check/visual-check/recover-output.'),
        inputPath: z.string().optional().describe('Path to specification JSON.'),
        outputPath: z.string().optional().describe('Target HTML, SVG, or migrated JSON path.'),
        artifactPath: z.string().optional().describe('Existing HTML path for check/browser-check/visual-check/export-svg.'),
        recoveryDir: z.string().optional().describe('Private recovery directory for recover-output.'),
        quality: z.enum(['standard', 'showcase']).optional(),
        repoRoot: z.string().optional(),
        outDir: z.string().optional(),
        receiptPath: z.string().optional(),
        candidateSha256: z.string().optional(),
        layoutJson: z.boolean().optional(),
        requireProvenance: z.boolean().optional(),
        theme: z.enum(['both', 'light', 'dark', 'auto']).optional(),
        preset: z.string().optional(),
        animateFlow: z.boolean().optional(),
        toSchema: z.number().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const inputPath = resolveMaybePath(args.inputPath, cwd);
      const outputPath = resolveMaybePath(args.outputPath, cwd);
      const artifactPath = resolveMaybePath(args.artifactPath, cwd);
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);
      const outDir = resolveMaybePath(args.outDir, cwd);
      const receiptPath = resolveMaybePath(args.receiptPath, cwd);

      if (args.action === 'recover-output') {
        const recDir = resolveMaybePath(args.recoveryDir || args.inputPath, cwd);
        if (!recDir) {
          return { isError: true, content: [{ type: 'text', text: 'recover-output requires recoveryDir.' }], structuredContent: { ok: false, error: 'Missing recoveryDir.' } };
        }
        const res = await runAuxiliaryScript('bin/recover-output.mjs', [recDir, '--json'], { cwd });
        return compactCliOutcome('recover-output', res);
      }

      if (args.action === 'export-svg' && artifactPath && !inputPath) {
        if (!outputPath) {
          return { isError: true, content: [{ type: 'text', text: 'export-svg from HTML requires outputPath (.svg).' }], structuredContent: { ok: false, error: 'Missing outputPath.' } };
        }
        const theme = args.theme && ['auto', 'light', 'dark'].includes(args.theme) ? args.theme : 'auto';
        const res = await runAuxiliaryScript('bin/export-svg.mjs', [artifactPath, outputPath, theme], { cwd });
        return {
          isError: !res.ok,
          content: [{ type: 'text', text: res.ok ? `Exported SVG to ${outputPath}` : (res.stderr || res.stdout).trim() }],
          structuredContent: { ok: res.ok, command: 'export-svg', artifactPath, outputPath, theme },
        };
      }

      const commonOpts = [
        ...(args.quality ? ['--quality', args.quality] : []),
        ...(repoRoot ? ['--repo-root', repoRoot] : []),
      ];

      let cliArgs;
      switch (args.action) {
        case 'finalize':
          cliArgs = [
            'finalize', args.type || 'architecture', inputPath, outputPath, '--json',
            ...commonOpts,
            ...(outDir ? ['--out-dir', outDir] : []),
            ...(receiptPath ? ['--receipt', receiptPath] : []),
            ...(args.candidateSha256 ? ['--candidate-sha256', args.candidateSha256] : []),
          ];
          break;
        case 'validate':
          cliArgs = ['validate', args.type || 'architecture', inputPath, '--json', ...(args.layoutJson ? ['--layout-json'] : []), ...commonOpts];
          break;
        case 'inspect':
          cliArgs = ['inspect', args.type || 'architecture', inputPath, '--json', ...commonOpts];
          break;
        case 'render':
          cliArgs = ['render', args.type || 'architecture', inputPath, ...(outputPath ? [outputPath] : []), ...commonOpts];
          break;
        case 'deliver':
          cliArgs = ['deliver', args.type || 'architecture', inputPath, ...(outputPath ? [outputPath] : []), '--json', ...commonOpts];
          break;
        case 'check':
          cliArgs = ['check', artifactPath || outputPath, '--json', ...(args.requireProvenance ? ['--require-provenance'] : [])];
          break;
        case 'browser-check':
        case 'visual-check':
          cliArgs = [
            args.action, artifactPath || outputPath, '--json',
            ...(args.requireProvenance ? ['--require-provenance'] : []),
            ...(outDir ? ['--out-dir', outDir] : []),
          ];
          break;
        case 'export-svg':
          cliArgs = [
            'export-svg', args.type || 'architecture', inputPath, outputPath, '--json',
            ...(args.theme && ['both', 'light', 'dark'].includes(args.theme) ? ['--theme', args.theme] : []),
            ...(args.preset ? ['--preset', args.preset] : []),
            ...(args.animateFlow ? ['--animate-flow'] : []),
            ...commonOpts,
          ];
          break;
        case 'migrate':
          cliArgs = [
            'migrate', 'workflow', inputPath, outputPath, '--to-schema', String(args.toSchema || 2), '--json',
            ...(args.artifactPath ? ['--output', resolveMaybePath(args.artifactPath, cwd)] : []),
            ...(repoRoot ? ['--repo-root', repoRoot] : []),
          ];
          break;
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      const htmlTarget = extractPathField(res.json?.artifact) || extractPathField(res.json?.output) || outputPath || artifactPath;
      const recorded = htmlTarget && htmlTarget.endsWith('.html')
        ? recordIfExists({
            kind: 'diagram',
            diagramType: args.type || null,
            title: (typeof res.json?.title === 'string' && res.json.title) || path.basename(htmlTarget, '.html'),
            outputPath: htmlTarget,
            inputPath,
            repoRoot,
            ok: res.ok,
            receiptSummary: res.json?.gates || null,
          })
        : null;

      return compactCliOutcome(`diagram ${args.action}`, res, {
        kind: 'diagram',
        diagramType: args.type || null,
        ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
      });
    },
  );

  // 4. One-Page Explainers: finalize, validate, render, deliver, patch, check, browser-check, visual-check
  registerAppTool(
    server,
    'archify_explainer',
    {
      title: 'Archify One-Page Explainer',
      description: 'Validate, deliver, finalize, render, patch a single panel, or check an Archify one-page explainer (.archify.md or .json -> standalone HTML).',
      inputSchema: {
        action: z.enum(['finalize', 'validate', 'render', 'deliver', 'patch', 'check', 'browser-check', 'visual-check']),
        inputPath: z.string().optional().describe('Explainer draft (.archify.md or .json).'),
        outputPath: z.string().optional().describe('Output HTML path.'),
        artifactPath: z.string().optional().describe('Existing explainer HTML path (for patch, check, browser-check, visual-check).'),
        panelId: z.string().optional().describe('Stable panel ID for action="patch".'),
        replacementPath: z.string().optional().describe('Replacement panel snippet file for action="patch".'),
        writing: z.enum(['warn', 'strict', 'off']).optional(),
        browserCheck: z.boolean().optional(),
        quality: z.enum(['standard', 'showcase']).optional(),
        repoRoot: z.string().optional(),
        outDir: z.string().optional(),
        receiptPath: z.string().optional(),
        requireProvenance: z.boolean().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const inputPath = resolveMaybePath(args.inputPath, cwd);
      const outputPath = resolveMaybePath(args.outputPath, cwd);
      const artifactPath = resolveMaybePath(args.artifactPath, cwd);
      const replacementPath = resolveMaybePath(args.replacementPath, cwd);
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);
      const outDir = resolveMaybePath(args.outDir, cwd);
      const receiptPath = resolveMaybePath(args.receiptPath, cwd);

      const writingArgs = args.writing ? ['--writing', args.writing] : [];
      const commonOpts = [
        ...(args.quality ? ['--quality', args.quality] : []),
        ...(repoRoot ? ['--repo-root', repoRoot] : []),
      ];

      let cliArgs;
      if (args.action === 'patch') {
        cliArgs = ['patch', 'explainer', artifactPath, args.panelId, replacementPath, outputPath, '--json', ...commonOpts, ...writingArgs];
      } else if (args.action === 'finalize') {
        cliArgs = [
          'finalize', 'explainer', inputPath, outputPath, '--json',
          ...(args.browserCheck ? ['--browser-check'] : []),
          ...(outDir ? ['--out-dir', outDir] : []),
          ...(receiptPath ? ['--receipt', receiptPath] : []),
          ...commonOpts,
          ...writingArgs,
        ];
      } else if (args.action === 'deliver') {
        cliArgs = ['deliver', 'explainer', inputPath, ...(outputPath ? [outputPath] : []), '--json', ...commonOpts, ...writingArgs];
      } else if (args.action === 'validate') {
        cliArgs = ['validate', 'explainer', inputPath, '--json', ...commonOpts, ...writingArgs];
      } else if (args.action === 'render') {
        cliArgs = ['render', 'explainer', inputPath, ...(outputPath ? [outputPath] : []), ...commonOpts];
      } else if (args.action === 'check') {
        cliArgs = ['check', artifactPath || outputPath, '--json', ...(args.requireProvenance ? ['--require-provenance'] : [])];
      } else {
        cliArgs = [
          args.action, artifactPath || outputPath, '--json',
          ...(args.requireProvenance ? ['--require-provenance'] : []),
          ...(outDir ? ['--out-dir', outDir] : []),
        ];
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      const htmlTarget = extractPathField(res.json?.artifact) || extractPathField(res.json?.output) || outputPath || artifactPath;
      const recorded = htmlTarget && htmlTarget.endsWith('.html')
        ? recordIfExists({
            kind: 'explainer',
            title: (typeof res.json?.title === 'string' && res.json.title) || path.basename(htmlTarget, '.html'),
            outputPath: htmlTarget,
            inputPath,
            repoRoot,
            ok: res.ok,
            receiptSummary: res.json?.gates || null,
          })
        : null;

      return compactCliOutcome(`explainer ${args.action}`, res, {
        kind: 'explainer',
        ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
      });
    },
  );

  // 5. Architecture Delta Comparison
  registerAppTool(
    server,
    'archify_compare',
    {
      title: 'Archify Architecture Compare',
      description: 'Compare base and head architecture specifications and produce an Architecture Delta HTML view and deterministic change receipt.',
      inputSchema: {
        basePath: z.string(),
        headPath: z.string(),
        outputPath: z.string().optional(),
        receiptPath: z.string().optional(),
        quality: z.enum(['standard', 'showcase']).optional(),
        repoRoot: z.string().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const basePath = resolveMaybePath(args.basePath, cwd);
      const headPath = resolveMaybePath(args.headPath, cwd);
      const outputPath = resolveMaybePath(args.outputPath, cwd);
      const receiptPath = resolveMaybePath(args.receiptPath, cwd);
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);

      const cliArgs = [
        'compare', 'architecture', basePath, headPath,
        ...(outputPath ? [outputPath] : []),
        ...(receiptPath ? ['--receipt', receiptPath] : []),
        ...(args.quality ? ['--quality', args.quality] : []),
        ...(repoRoot ? ['--repo-root', repoRoot] : []),
        '--json',
      ];
      const res = await runArchifyCli(cliArgs, { cwd });
      const htmlTarget = extractPathField(res.json?.output) || extractPathField(res.json?.artifact) || outputPath;
      const recorded = htmlTarget
        ? recordIfExists({
            kind: 'compare',
            title: `Delta: ${path.basename(basePath)} -> ${path.basename(headPath)}`,
            outputPath: htmlTarget,
            inputPath: headPath,
            repoRoot,
            ok: res.ok,
            receiptSummary: res.json?.summary || null,
          })
        : null;

      return compactCliOutcome('compare architecture', res, {
        kind: 'compare',
        ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
      });
    },
  );

  // 6. Guided Stories & Choreography (scan, draft, attach, validate, svg, stage, video)
  registerAppTool(
    server,
    'archify_story',
    {
      title: 'Archify Story & Video',
      description: 'Scan native HTML for story anchors, draft or attach interactive Story walkthroughs, or compile declarative choreography/briefs into dual-theme SVG, stage HTML, or 1080p MP4/WebM video.',
      inputSchema: {
        action: z.enum(['scan', 'draft', 'attach', 'validate', 'svg', 'stage', 'video']),
        nativeHtmlPath: z.string().optional().describe('Native diagram HTML (for scan/draft/attach or single-diagram svg/stage/video bridge).'),
        briefPath: z.string().optional().describe('Story brief JSON (version 2).'),
        choreographyPath: z.string().optional().describe('Declarative choreography JSON (for validate/svg/stage/video).'),
        outputPath: z.string().optional().describe('Output HTML, SVG/stem, or MP4/WebM path.'),
        theme: z.enum(['both', 'light', 'dark']).optional(),
        preset: z.string().optional(),
        still: z.boolean().optional(),
        format: z.enum(['mp4', 'webm']).optional(),
        fps: z.enum(['30', '60']).optional(),
        start: z.number().optional(),
        seconds: z.number().optional(),
        quality: z.enum(['standard', 'showcase']).optional(),
        repoRoot: z.string().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const nativeHtml = resolveMaybePath(args.nativeHtmlPath, cwd);
      const briefPath = resolveMaybePath(args.briefPath, cwd);
      const choreoPath = resolveMaybePath(args.choreographyPath, cwd);
      const outputPath = resolveMaybePath(args.outputPath, cwd);
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);

      let cliArgs;
      if (args.action === 'scan') {
        cliArgs = ['story', 'scan', nativeHtml, '--json'];
      } else if (args.action === 'draft') {
        cliArgs = ['story', 'draft', nativeHtml, briefPath, '--json'];
      } else if (args.action === 'attach') {
        cliArgs = ['story', 'attach', nativeHtml, briefPath, outputPath, '--json', ...(repoRoot ? ['--repo-root', repoRoot] : [])];
      } else if (args.action === 'validate') {
        cliArgs = [
          'story', 'validate', choreoPath || briefPath, '--json',
          ...(repoRoot ? ['--repo-root', repoRoot] : []),
          ...(args.quality ? ['--quality', args.quality] : []),
        ];
      } else {
        const positionals = choreoPath ? [choreoPath, outputPath] : [nativeHtml, briefPath, outputPath];
        cliArgs = [
          'story', args.action, ...positionals.filter(Boolean), '--json',
          ...(args.theme ? ['--theme', args.theme] : []),
          ...(args.preset ? ['--preset', args.preset] : []),
          ...(args.still ? ['--still'] : []),
          ...(args.format ? ['--format', args.format] : []),
          ...(args.fps ? ['--fps', args.fps] : []),
          ...(args.start !== undefined ? ['--start', String(args.start)] : []),
          ...(args.seconds !== undefined ? ['--seconds', String(args.seconds)] : []),
          ...(args.quality ? ['--quality', args.quality] : []),
          ...(repoRoot ? ['--repo-root', repoRoot] : []),
        ];
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      const artifactCandidate = extractPathField(res.json?.output) || extractPathField(res.json?.artifact) || outputPath;
      const recorded = artifactCandidate && (artifactCandidate.endsWith('.html') || artifactCandidate.endsWith('.svg'))
        ? recordIfExists({
            kind: 'story',
            title: (typeof res.json?.title === 'string' && res.json.title) || path.basename(artifactCandidate),
            outputPath: artifactCandidate,
            inputPath: choreoPath || briefPath || nativeHtml,
            repoRoot,
            ok: res.ok,
          })
        : null;

      return compactCliOutcome(`story ${args.action}`, res, {
        kind: 'story',
        ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
      });
    },
  );

  // 7. Pull Request Visual Packs (preflight, validate, build, attach)
  registerAppTool(
    server,
    'archify_pr',
    {
      title: 'Archify PR Visual Pack',
      description: 'Run 3-dot merge-base PR preflight and materiality check, validate a pr-pack manifest, build Camo-safe dual-theme visual packs, or attach to GitHub PR / GitLab MR.',
      inputSchema: {
        action: z.enum(['preflight', 'validate', 'build', 'attach']),
        repoRoot: z.string().optional(),
        base: z.string().optional(),
        head: z.string().optional(),
        initDir: z.string().optional(),
        mode: z.enum(['ask', 'on-demand', 'proactive']).optional(),
        target: z.enum(['body', 'comment']).optional(),
        globalRules: z.string().optional(),
        manifestPath: z.string().optional().describe('Path to pr-pack.json or pr-pack.receipt.json (for attach).'),
        outDir: z.string().optional(),
        platform: z.enum(['github', 'gitlab', 'generic']).optional(),
        noHtml: z.boolean().optional(),
        animateFlow: z.boolean().optional(),
        quality: z.enum(['standard', 'showcase']).optional(),
        pullRequest: z.string().optional().describe('PR number, GitHub PR URL, or GitLab MR URL for action="attach".'),
        repo: z.string().optional().describe('owner/name override for action="attach".'),
        allowStale: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);
      const manifestPath = resolveMaybePath(args.manifestPath, cwd);
      const outDir = resolveMaybePath(args.outDir, cwd);
      const initDir = resolveMaybePath(args.initDir, cwd);

      let cliArgs;
      if (args.action === 'preflight') {
        cliArgs = [
          'pr', 'preflight', '--json',
          ...(repoRoot ? ['--repo-root', repoRoot] : []),
          ...(args.base ? ['--base', args.base] : []),
          ...(args.head ? ['--head', args.head] : []),
          ...(initDir ? ['--init', initDir] : []),
          ...(args.mode ? ['--mode', args.mode] : []),
          ...(args.target ? ['--target', args.target] : []),
          ...(args.globalRules ? ['--global-rules', args.globalRules] : []),
        ];
      } else if (args.action === 'validate') {
        cliArgs = ['pr', 'validate', manifestPath, '--json', ...(repoRoot ? ['--repo-root', repoRoot] : [])];
      } else if (args.action === 'build') {
        cliArgs = [
          'pr', 'build', manifestPath, '--out-dir', outDir, '--json',
          ...(repoRoot ? ['--repo-root', repoRoot] : []),
          ...(args.platform ? ['--platform', args.platform] : []),
          ...(args.noHtml ? ['--no-html'] : []),
          ...(args.animateFlow ? ['--animate-flow'] : []),
          ...(args.quality ? ['--quality', args.quality] : []),
        ];
      } else {
        cliArgs = [
          'pr', 'attach', args.pullRequest, '--manifest', manifestPath, '--json',
          ...(args.target ? ['--target', args.target] : []),
          ...(args.repo ? ['--repo', args.repo] : []),
          ...(args.allowStale ? ['--allow-stale'] : []),
          ...(args.dryRun ? ['--dry-run'] : []),
        ];
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      const receiptOut = args.action === 'build' && outDir ? path.join(outDir, 'pr-pack.receipt.json') : null;
      const recorded = receiptOut
        ? recordIfExists({
            kind: 'pr',
            title: res.json?.title || 'PR Visual Pack',
            outputPath: receiptOut,
            inputPath: manifestPath,
            repoRoot,
            ok: res.ok,
            receiptSummary: res.json?.stats || null,
          })
        : null;

      return compactCliOutcome(`pr ${args.action}`, res, {
        kind: 'pr',
        ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
      });
    },
  );

  // 8. Code Analysis Workbench, Headless CI Check, Tasks, Drift, External Review & Live Preview Servers
  registerAppTool(
    server,
    'archify_code_analysis',
    {
      title: 'Archify Code Analysis',
      description: 'Run source-backed repository architecture analysis (prepare workbench, CI check, AI refactoring tasks, verification, git drift, PR review import, or start/stop live preview servers).',
      inputSchema: {
        action: z.enum([
          'prepare',
          'check',
          'task',
          'verify-change',
          'drift',
          'verify-drift',
          'import-review',
          'start_server',
          'list_servers',
          'stop_server',
        ]),
        repoRoot: z.string().optional(),
        outDir: z.string().optional(),
        irPath: z.string().optional(),
        locale: z.enum(['en', 'zh-CN']).optional(),
        language: z.enum(['ts', 'py', 'java', 'go', 'rust', 'c', 'cpp']).optional(),
        mapFile: z.string().optional(),
        configFile: z.string().optional(),
        baselineFile: z.string().optional(),
        compareFile: z.string().optional(),
        failOn: z.enum(['error', 'warning', 'info', 'never']).optional(),
        newOnly: z.boolean().optional(),
        updateBaseline: z.boolean().optional(),
        acceptId: z.string().optional(),
        revokeId: z.string().optional(),
        reason: z.string().optional(),
        analysisDir: z.string().optional(),
        findings: z.array(z.string()).optional(),
        question: z.string().optional(),
        entry: z.string().optional(),
        baseRoot: z.string().optional(),
        functionName: z.string().optional(),
        context: z.string().optional(),
        verifyTaskPath: z.string().optional(),
        taskPath: z.string().optional(),
        checksPath: z.string().optional(),
        checksTemplate: z.boolean().optional(),
        command: z.string().optional(),
        format: z.enum(['md', 'json']).optional(),
        requireValid: z.boolean().optional(),
        baseSha: z.string().optional(),
        headSha: z.string().optional(),
        fromReport: z.string().optional(),
        originalDriftPath: z.string().optional(),
        afterDriftPath: z.string().optional(),
        prUrl: z.string().optional(),
        repository: z.string().optional(),
        scope: z.string().optional(),
        author: z.string().optional(),
        quality: z.enum(['standard', 'showcase']).optional(),
        serverMode: z.enum(['start', 'code-analysis-serve', 'preview']).optional(),
        previewType: z.enum(DIAGRAM_TYPES).optional(),
        previewInput: z.string().optional(),
        previewOutput: z.string().optional(),
        serverId: z.string().optional(),
        cwd: z.string().optional(),
      },
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async (args) => {
      const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
      const repoRoot = resolveMaybePath(args.repoRoot, cwd);
      const outDir = resolveMaybePath(args.outDir, cwd);
      const irPath = resolveMaybePath(args.irPath, cwd);
      const analysisDir = resolveMaybePath(args.analysisDir, cwd);

      if (args.action === 'list_servers') {
        const list = servers.list();
        return {
          content: [{ type: 'text', text: JSON.stringify(list, null, 2) }],
          structuredContent: { ok: true, command: 'list_servers', servers: list },
        };
      }

      if (args.action === 'stop_server') {
        const stopped = args.serverId ? servers.stop(args.serverId) : false;
        return {
          isError: !stopped,
          content: [{ type: 'text', text: stopped ? `Stopped server ${args.serverId}` : `Server not found: ${args.serverId}` }],
          structuredContent: { ok: stopped, command: 'stop_server', serverId: args.serverId || null },
        };
      }

      if (args.action === 'start_server') {
        const mode = args.serverMode || 'start';
        let cliArgs;
        if (mode === 'preview') {
          cliArgs = [
            'preview', args.previewType || 'architecture', resolveMaybePath(args.previewInput, cwd),
            ...(args.previewOutput ? [resolveMaybePath(args.previewOutput, cwd)] : []),
            '--no-open',
            ...(args.quality ? ['--quality', args.quality] : []),
            ...(repoRoot ? ['--repo-root', repoRoot] : []),
          ];
        } else {
          cliArgs = [
            ...(mode === 'code-analysis-serve' ? ['code-analysis', 'serve'] : ['start']),
            repoRoot || cwd,
            ...(outDir ? ['--out', outDir] : []),
            ...(irPath ? ['--ir', irPath] : []),
            ...(args.locale ? ['--locale', args.locale] : []),
            ...(args.language ? ['--language', args.language] : []),
            ...(args.mapFile ? ['--map', resolveMaybePath(args.mapFile, cwd)] : []),
            ...(args.configFile ? ['--config', resolveMaybePath(args.configFile, cwd)] : []),
            ...(args.baselineFile ? ['--baseline', resolveMaybePath(args.baselineFile, cwd)] : []),
            ...(args.quality ? ['--quality', args.quality] : []),
          ];
        }
        const info = await servers.start(mode, cliArgs, { cwd });
        return {
          content: [{ type: 'text', text: `Started ${mode} server at ${info.url} (id: ${info.id})` }],
          structuredContent: { ok: true, command: 'start_server', ...info },
        };
      }

      const sharedFilterOpts = [
        ...(args.language ? ['--language', args.language] : []),
        ...(args.configFile ? ['--config', resolveMaybePath(args.configFile, cwd)] : []),
        ...(irPath ? ['--ir', irPath] : []),
        ...(args.mapFile ? ['--map', resolveMaybePath(args.mapFile, cwd)] : []),
        ...(args.baselineFile ? ['--baseline', resolveMaybePath(args.baselineFile, cwd)] : []),
      ];

      let cliArgs;
      switch (args.action) {
        case 'prepare':
          cliArgs = [
            'code-analysis', 'prepare', repoRoot || cwd, '--out', outDir,
            ...(args.locale ? ['--locale', args.locale] : []),
            ...(args.prUrl ? ['--pr', args.prUrl] : []),
            ...(args.repository ? ['--repository', args.repository] : []),
            ...(args.scope ? ['--scope', args.scope] : []),
            ...(args.quality ? ['--quality', args.quality] : []),
            ...sharedFilterOpts,
          ];
          break;
        case 'check':
          cliArgs = [
            'code-analysis', 'check', repoRoot || cwd, '--json',
            ...sharedFilterOpts,
            ...(args.compareFile ? ['--compare', resolveMaybePath(args.compareFile, cwd)] : []),
            ...(outDir ? ['--out', outDir] : []),
            ...(args.failOn ? ['--fail-on', args.failOn] : []),
            ...(args.newOnly ? ['--new-only'] : []),
            ...(args.updateBaseline ? ['--update-baseline'] : []),
            ...(args.acceptId ? ['--accept', args.acceptId] : []),
            ...(args.revokeId ? ['--revoke', args.revokeId] : []),
            ...(args.reason ? ['--reason', args.reason] : []),
          ];
          break;
        case 'task':
          cliArgs = [
            'code-analysis', 'task',
            ...(analysisDir ? [analysisDir] : []),
            ...(args.verifyTaskPath ? ['--verify', resolveMaybePath(args.verifyTaskPath, cwd)] : []),
            ...(args.findings || []).flatMap((id) => ['--finding', id]),
            ...(args.question ? ['--question', args.question] : []),
            ...(args.entry ? ['--entry', resolveMaybePath(args.entry, cwd)] : []),
            ...(args.baseRoot ? ['--base-root', resolveMaybePath(args.baseRoot, cwd)] : []),
            ...(args.functionName ? ['--function', args.functionName] : []),
            ...(args.context ? ['--context', args.context] : []),
            ...(args.configFile ? ['--config', resolveMaybePath(args.configFile, cwd)] : []),
            ...(repoRoot ? ['--root', repoRoot] : []),
            ...(args.command ? ['--command', args.command] : []),
            ...(args.format ? ['--format', args.format] : []),
            ...(outDir ? ['--out', outDir] : []),
            ...(args.requireValid ? ['--require-valid'] : []),
            ...(outDir ? ['--json'] : []),
          ];
          break;
        case 'verify-change':
          cliArgs = [
            'code-analysis', 'verify-change', analysisDir, '--task', resolveMaybePath(args.taskPath, cwd),
            ...(args.checksTemplate ? ['--checks-template'] : args.checksPath ? ['--checks', resolveMaybePath(args.checksPath, cwd)] : []),
          ];
          break;
        case 'drift':
          cliArgs = [
            'code-analysis', 'drift', repoRoot || cwd,
            '--base', args.baseSha, '--head', args.headSha,
            '--ir', irPath, '--out', outDir, '--json',
            ...(args.mapFile ? ['--map', resolveMaybePath(args.mapFile, cwd)] : []),
            ...(args.configFile ? ['--config', resolveMaybePath(args.configFile, cwd)] : []),
            ...(args.fromReport ? ['--from-report', resolveMaybePath(args.fromReport, cwd)] : []),
            ...(args.locale ? ['--locale', args.locale] : []),
          ];
          break;
        case 'verify-drift':
          cliArgs = [
            'code-analysis', 'verify-drift', resolveMaybePath(args.originalDriftPath, cwd),
            '--task', resolveMaybePath(args.taskPath, cwd),
            '--after', resolveMaybePath(args.afterDriftPath, cwd),
            ...(args.checksTemplate ? ['--checks-template'] : args.checksPath ? ['--checks', resolveMaybePath(args.checksPath, cwd)] : []),
          ];
          break;
        case 'import-review':
          cliArgs = [
            'code-analysis', 'import-review', args.prUrl, '--out', outDir, '--json',
            ...(args.author ? ['--author', args.author] : []),
          ];
          break;
      }

      const res = await runArchifyCli(cliArgs, { cwd });
      const htmlTarget = extractPathField(res.json?.html)
        || extractPathField(res.json?.artifact)
        || (args.action === 'prepare' && outDir ? path.join(outDir, 'analysis', 'repo.analysis.html') : null);
      const recorded = htmlTarget
        ? recordIfExists({
            kind: 'code-analysis',
            title: `Code Analysis (${path.basename(repoRoot || cwd)})`,
            outputPath: htmlTarget,
            repoRoot: repoRoot || cwd,
            ok: res.ok,
            receiptSummary: res.json?.summary || null,
          })
        : null;

      if (res.json) {
        return compactCliOutcome(`code-analysis ${args.action}`, res, {
          kind: 'code-analysis',
          ...(recorded ? { artifactId: recorded.id, artifactPath: recorded.outputPath, fileUrl: recorded.fileUrl } : {}),
        });
      }
      return {
        isError: !res.ok,
        content: [{ type: 'text', text: (res.stdout || res.stderr || '').trim() }],
        structuredContent: { ok: res.ok, command: `code-analysis ${args.action}`, exitCode: res.exitCode, stdout: res.stdout },
      };
    },
  );

  // =========================================================================
  // App-Only Tools (`visibility: ["app"]`) — callable by Archify Studio UI only
  // =========================================================================

  registerAppTool(
    server,
    'app_list_artifacts',
    {
      title: 'List Artifacts (App)',
      description: 'Return persisted and workspace .archify/ artifacts for the Archify Studio library.',
      inputSchema: {
        workspaceDir: z.string().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ workspaceDir }) => {
      const ws = workspaceDir || store.getPreferences().lastWorkspace || process.cwd();
      const artifacts = store.listCombined(ws);
      return {
        content: [{ type: 'text', text: `${artifacts.length} artifacts` }],
        structuredContent: { ok: true, artifacts },
      };
    },
  );

  registerAppTool(
    server,
    'app_load_artifact',
    {
      title: 'Load Artifact View (App)',
      description: 'Extract clean SVG, semantic nodes/edges, panels, delta rows, or Code Analysis data for Archify Studio.',
      inputSchema: {
        artifactId: z.string().optional(),
        artifactPath: z.string().optional(),
        kind: z.enum(['diagram', 'explainer', 'compare', 'story', 'pr', 'code-analysis']).optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ artifactId, artifactPath, kind }) => {
      const entry = artifactId ? store.findByIdOrPath(artifactId) : null;
      const target = entry?.outputPath || (artifactPath ? path.resolve(artifactPath) : null);
      if (!target) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Specify artifactId or artifactPath.' }],
          structuredContent: { ok: false, error: 'Missing artifactId or artifactPath.' },
        };
      }
      const payload = extractArtifactViewPayload(target, {
        kind: kind || entry?.kind || null,
        repoRoot: entry?.repoRoot || null,
      });
      return {
        content: [{ type: 'text', text: `Loaded ${payload.title}` }],
        structuredContent: payload,
      };
    },
  );

  registerAppTool(
    server,
    'app_export_artifact',
    {
      title: 'Export or Visually Check Artifact (App)',
      description: 'Run export-svg or visual-check on an artifact from the Archify Studio toolbar.',
      inputSchema: {
        action: z.enum(['export-svg', 'visual-check']),
        artifactPath: z.string(),
        theme: z.enum(['auto', 'light', 'dark']).optional(),
        outputPath: z.string().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ action, artifactPath, theme, outputPath }) => {
      const resolved = path.resolve(artifactPath);
      if (action === 'export-svg') {
        const out = outputPath
          ? path.resolve(outputPath)
          : resolved.replace(/\.html$/i, `.${theme || 'auto'}.${Date.now()}.svg`);
        const res = await runAuxiliaryScript('bin/export-svg.mjs', [resolved, out, theme || 'auto'], {
          cwd: path.dirname(resolved),
        });
        return {
          isError: !res.ok,
          content: [{ type: 'text', text: res.ok ? `Exported ${out}` : (res.stderr || res.stdout).trim() }],
          structuredContent: { ok: res.ok, action, outputPath: out },
        };
      }
      const res = await runArchifyCli(['visual-check', resolved, '--json'], { cwd: path.dirname(resolved) });
      return compactCliOutcome('visual-check', res);
    },
  );

  registerAppTool(
    server,
    'app_save_preferences',
    {
      title: 'Save Studio Preferences (App)',
      description: 'Persist Archify Studio UI theme, preset, or workspace preference.',
      inputSchema: {
        theme: z.enum(['auto', 'light', 'dark']).optional(),
        preset: z.enum(['classic', 'signal-flow', 'blueprint', 'editorial']).nullable().optional(),
        lastWorkspace: z.string().nullable().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const prefs = store.savePreferences(args);
      return {
        content: [{ type: 'text', text: 'Preferences saved.' }],
        structuredContent: { ok: true, preferences: prefs },
      };
    },
  );

  return server;
}

export async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((error) => {
    console.error(`archify-mcp fatal error: ${error?.stack || error}`);
    process.exit(1);
  });
}
