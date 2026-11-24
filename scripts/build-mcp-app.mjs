/**
 * Build the self-contained single-file MCP App HTML (mcp/dist/viewer.html)
 * from mcp/app/index.html, mcp/app/styles.css, mcp/app/main.ts, and scoped
 * Archify Viewer SVG CSS tokens.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildScopedSvgThemeCss } from '../mcp/runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAX_APP_BYTES = 10 * 1024 * 1024;

export async function buildMcpApp() {
  const indexHtmlPath = path.join(ROOT, 'mcp', 'app', 'index.html');
  const stylesPath = path.join(ROOT, 'mcp', 'app', 'styles.css');
  const entryTsPath = path.join(ROOT, 'mcp', 'app', 'main.ts');
  const outHtmlPath = path.join(ROOT, 'mcp', 'dist', 'viewer.html');

  const template = fs.readFileSync(indexHtmlPath, 'utf8');
  const baseCss = fs.readFileSync(stylesPath, 'utf8');
  const scopedSvgCss = buildScopedSvgThemeCss();
  const combinedCss = baseCss.replace('/* ARCHIFY_SCOPED_SVG_CSS */', () => scopedSvgCss);

  const bundled = await esbuild.build({
    entryPoints: [entryTsPath],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    write: false,
  });

  const jsCode = bundled.outputFiles[0]?.text;
  if (!jsCode) throw new Error('esbuild produced no JavaScript bundle for mcp/app/main.ts');

  const html = template
    .replace('<!-- ARCHIFY_STUDIO_CSS -->', () => `<style>\n${combinedCss}\n</style>`)
    .replace('<!-- ARCHIFY_STUDIO_JS -->', () => `<script>\n${jsCode}\n</script>`);

  if (/<(script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
    throw new Error('MCP App bundle must not reference external CDN scripts or stylesheets.');
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes >= MAX_APP_BYTES) {
    throw new Error(`MCP App bundle exceeds 10 MiB (${bytes} bytes).`);
  }

  fs.mkdirSync(path.dirname(outHtmlPath), { recursive: true });
  fs.writeFileSync(outHtmlPath, html, 'utf8');
  return { outHtmlPath, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMcpApp()
    .then(({ outHtmlPath, bytes }) => {
      console.log(`Built ${path.relative(ROOT, outHtmlPath)} (${(bytes / 1024).toFixed(1)} KiB)`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
