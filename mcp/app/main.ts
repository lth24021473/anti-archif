import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

type ArtifactSummary = {
  id: string;
  kind: string;
  diagramType?: string | null;
  title: string;
  outputPath: string;
  fileUrl: string;
  updatedAt?: string;
};

type DiagramNode = {
  id: string;
  label: string;
  kind: string;
  sublabel?: string;
  tag?: string;
  context?: string;
  explanation?: string | null;
  payload?: unknown;
  sources?: Array<{ path: string; line?: number; endLine?: number; label?: string }>;
  drilldowns?: Array<{ label: string; href: string }>;
  incoming?: Array<{ id: string; from: string; label?: string }>;
  outgoing?: Array<{ id: string; to: string; label?: string }>;
};

type ViewPayload = {
  kind: 'diagram' | 'explainer' | 'compare' | 'story' | 'pr' | 'code-analysis';
  title: string;
  subtitle?: string;
  artifactPath: string;
  fileUrl?: string;
  repoRoot?: string | null;
  diagramType?: string;
  preset?: string;
  svg?: string;
  nodes?: DiagramNode[];
  edges?: Array<{ id: string; from: string; to: string; label?: string }>;
  answer?: { summary?: string; reasons?: string[]; scope?: string } | null;
  panels?: Array<{ id: string; title: string; blocks?: any[]; charts?: string[] }>;
  diagrams?: Record<string, { diagramType: string; svg: string }>;
  deltaSvg?: string;
  baseSvg?: string;
  headSvg?: string;
  changeRows?: Array<{ id: string; kind: string; status: string; label?: string; changedFields?: string[] }>;
  receipt?: any;
  storyKind?: 'stage' | 'attached';
  storyPlan?: any;
  steps?: Array<{ index: number; title: string; body?: string; at?: number }>;
  panes?: Array<{ theme: string; svg: string }>;
  markdown?: string;
  svgs?: Array<{ name: string; path: string; svg: string }>;
  verdict?: string;
  counts?: Record<string, number | null>;
  coverage?: any;
  priorities?: string[];
  investigation?: any;
  modules?: Array<{ id: string; label: string; path: string; files: number; loc: number; fanIn: number; fanOut: number; instability: number | null }>;
  moduleEdges?: Array<{ from: string; to: string; weight: number }>;
  findings?: Array<{ id: string; code: string; dimension: string; severity: string; message: string; subject?: any; supportedFixes?: string[] }>;
};

const app = new App({ name: 'Archify Studio', version: '3.3.0' }, {});

const els = {
  title: document.getElementById('studio-title')!,
  subtitle: document.getElementById('studio-subtitle')!,
  badge: document.getElementById('studio-badge')!,
  banner: document.getElementById('status-banner')!,
  empty: document.getElementById('empty-state')!,
  modeView: document.getElementById('mode-view')!,
  libraryDrawer: document.getElementById('library-drawer')!,
  libraryList: document.getElementById('library-list')!,
  passportDrawer: document.getElementById('passport-drawer')!,
  passportEyebrow: document.getElementById('passport-eyebrow')!,
  passportTitle: document.getElementById('passport-title')!,
  passportBody: document.getElementById('passport-body')!,
  searchInput: document.getElementById('search-input') as HTMLInputElement,
  presetSelect: document.getElementById('preset-select') as HTMLSelectElement,
  btnLibrary: document.getElementById('btn-library')!,
  btnRefreshLibrary: document.getElementById('btn-refresh-library')!,
  btnOpenLibraryEmpty: document.getElementById('btn-open-library-empty')!,
  btnTheme: document.getElementById('btn-theme')!,
  btnZoomOut: document.getElementById('btn-zoom-out')!,
  btnZoomFit: document.getElementById('btn-zoom-fit')!,
  btnZoomIn: document.getElementById('btn-zoom-in')!,
  btnExportSvg: document.getElementById('btn-export-svg')!,
  btnVisualCheck: document.getElementById('btn-visual-check')!,
  btnClosePassport: document.getElementById('btn-close-passport')!,
};

let currentTheme: 'light' | 'dark' = 'dark';
let currentPreset = 'classic';
let currentPayload: ViewPayload | null = null;
let currentZoom = 1;
let panX = 0;
let panY = 0;
let selectedNodeId: string | null = null;
let storyInterval: number | null = null;
let storyIndex = 0;

function showBanner(message: string, timeoutMs = 4500) {
  els.banner.textContent = message;
  els.banner.hidden = false;
  if (timeoutMs > 0) {
    window.setTimeout(() => {
      if (els.banner.textContent === message) els.banner.hidden = true;
    }, timeoutMs);
  }
}

function applyThemeState(theme?: string) {
  if (theme === 'light' || theme === 'dark') {
    currentTheme = theme;
    applyDocumentTheme(theme);
  }
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.querySelectorAll<HTMLElement>('.archify-svg-host').forEach((host) => {
    host.setAttribute('data-theme', currentTheme);
    host.setAttribute('data-preset', currentPreset);
    host.querySelectorAll('svg').forEach((svg) => {
      svg.setAttribute('data-theme', currentTheme);
      svg.setAttribute('data-preset', currentPreset);
    });
  });
}

function applyHostContext(ctx: any) {
  if (!ctx) return;
  if (ctx.theme) applyThemeState(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function clearElement(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function canMessageHost() {
  return Boolean(app.getHostCapabilities()?.message);
}

function canUpdateContext() {
  return Boolean(app.getHostCapabilities()?.updateModelContext);
}

async function openSourceInAntigravity(relOrAbsPath: string, line?: number) {
  const repoRoot = currentPayload?.repoRoot || '';
  const absPath = /^[a-zA-Z]:[\\/]|^\//.test(relOrAbsPath)
    ? relOrAbsPath
    : repoRoot
      ? `${repoRoot.replace(/[\\/]+$/, '')}/${relOrAbsPath.replace(/^[\\/]+/, '')}`
      : relOrAbsPath;
  const normalized = absPath.replace(/\\/g, '/');
  const uri = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;

  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri },
      },
      z.object({ isError: z.boolean().optional() }).passthrough(),
    );
    if (!res?.isError) {
      showBanner(`Opened ${relOrAbsPath}${line ? `:${line}` : ''} in side pane.`);
      return;
    }
  } catch {
    // Host does not support toggle-aux-pane (e.g. global view or standalone host).
  }

  try {
    await navigator.clipboard?.writeText(`${absPath}${line ? `:${line}` : ''}`);
    showBanner(`Copied path: ${absPath}${line ? `:${line}` : ''}`);
  } catch {
    showBanner(`Source: ${absPath}${line ? `:${line}` : ''}`);
  }
}

async function attachContextToPrompt(label: string, text: string) {
  if (!canUpdateContext()) {
    showBanner('Context attachment is unavailable in this view.');
    return;
  }
  await app.updateModelContext({
    content: [{ type: 'text', text }],
  });
  showBanner(`Attached "${label}" to your next prompt.`);
}

async function askAgent(promptText: string) {
  if (!canMessageHost()) {
    showBanner('Conversation messaging is unavailable in this view.');
    return;
  }
  await app.sendMessage({
    role: 'user',
    content: [{ type: 'text', text: promptText }],
  });
  showBanner('Sent question to Antigravity conversation.');
}

function applyTransform(layer: HTMLElement) {
  layer.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
}

function createZoomableSvgViewport(svgMarkup: string, onNodeSelect?: (id: string) => void) {
  const viewport = makeEl('div', 'svg-viewport');
  const layer = makeEl('div', 'svg-transform-layer archify-svg-host');
  layer.setAttribute('data-theme', currentTheme);
  layer.setAttribute('data-preset', currentPreset);
  layer.innerHTML = svgMarkup;

  currentZoom = 1;
  panX = 0;
  panY = 0;
  applyTransform(layer);

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let moved = false;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nextX = e.clientX - startX;
    const nextY = e.clientY - startY;
    if (Math.abs(nextX - panX) > 3 || Math.abs(nextY - panY) > 3) moved = true;
    panX = nextX;
    panY = nextY;
    applyTransform(layer);
  });

  window.addEventListener('pointerup', () => {
    dragging = false;
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    currentZoom = Math.max(0.25, Math.min(4, currentZoom * factor));
    applyTransform(layer);
  }, { passive: false });

  if (onNodeSelect) {
    layer.addEventListener('click', (e) => {
      if (moved) return;
      const target = (e.target as HTMLElement | null)?.closest('[data-node-id]');
      const nodeId = target?.getAttribute('data-node-id');
      if (nodeId) onNodeSelect(nodeId);
    });
  }

  viewport.appendChild(layer);
  return { viewport, layer };
}

function openInspector(node: DiagramNode, svgHost: HTMLElement) {
  selectedNodeId = node.id;
  svgHost.querySelectorAll('[data-node-id]').forEach((el) => {
    el.classList.toggle('studio-node-selected', el.getAttribute('data-node-id') === node.id);
  });

  els.passportEyebrow.textContent = `${(node.kind || 'component').toUpperCase()} · ${node.id}`;
  els.passportTitle.textContent = node.label || node.id;
  clearElement(els.passportBody);

  const metaSec = makeEl('div', 'passport-section');
  metaSec.appendChild(makeEl('h3', undefined, 'Details'));
  if (node.sublabel) metaSec.appendChild(makeEl('p', undefined, node.sublabel));
  if (node.context) metaSec.appendChild(makeEl('div', 'passport-kv', `Scope: ${node.context}`));
  if (node.tag) metaSec.appendChild(makeEl('div', 'passport-kv', `Domain: ${node.tag}`));
  if (node.explanation) metaSec.appendChild(makeEl('p', undefined, node.explanation));
  els.passportBody.appendChild(metaSec);

  if (node.sources?.length) {
    const srcSec = makeEl('div', 'passport-section');
    srcSec.appendChild(makeEl('h3', undefined, 'Verified Sources'));
    const list = makeEl('div', 'chip-list');
    for (const src of node.sources) {
      const label = `${src.path}${src.line ? `:${src.line}` : ''}`;
      const btn = makeEl('button', 'link-btn', label);
      btn.type = 'button';
      btn.addEventListener('click', () => void openSourceInAntigravity(src.path, src.line));
      list.appendChild(btn);
    }
    srcSec.appendChild(list);
    els.passportBody.appendChild(srcSec);
  }

  if (node.incoming?.length || node.outgoing?.length) {
    const relSec = makeEl('div', 'passport-section');
    relSec.appendChild(makeEl('h3', undefined, 'Relationships'));
    const list = makeEl('div', 'chip-list');
    for (const rel of node.incoming || []) {
      const btn = makeEl('button', 'link-btn', `← ${rel.from}${rel.label ? ` (${rel.label})` : ''}`);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const target = currentPayload?.nodes?.find((n) => n.id === rel.from);
        if (target) openInspector(target, svgHost);
      });
      list.appendChild(btn);
    }
    for (const rel of node.outgoing || []) {
      const btn = makeEl('button', 'link-btn', `→ ${rel.to}${rel.label ? ` (${rel.label})` : ''}`);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const target = currentPayload?.nodes?.find((n) => n.id === rel.to);
        if (target) openInspector(target, svgHost);
      });
      list.appendChild(btn);
    }
    relSec.appendChild(list);
    els.passportBody.appendChild(relSec);
  }

  if (node.drilldowns?.length) {
    const drillSec = makeEl('div', 'passport-section');
    drillSec.appendChild(makeEl('h3', undefined, 'Drilldowns'));
    const list = makeEl('div', 'chip-list');
    for (const item of node.drilldowns) {
      const btn = makeEl('button', 'link-btn', `↗ ${item.label} (${item.href})`);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (currentPayload?.artifactPath && !item.href.startsWith('http')) {
          const dir = currentPayload.artifactPath.replace(/[\\/][^\\/]+$/, '');
          const cleanHref = item.href.split(/[?#]/)[0];
          void loadArtifact({ artifactPath: `${dir}/${cleanHref}` });
        }
      });
      list.appendChild(btn);
    }
    drillSec.appendChild(list);
    els.passportBody.appendChild(drillSec);
  }

  const actionsSec = makeEl('div', 'passport-section');
  actionsSec.appendChild(makeEl('h3', undefined, 'Antigravity Actions'));
  const list = makeEl('div', 'chip-list');
  const summaryText = `Archify Node "${node.label}" (${node.id}, kind=${node.kind}) from ${currentPayload?.artifactPath || ''}`
    + (node.sources?.length ? `\nSources: ${node.sources.map((s) => `${s.path}${s.line ? `:${s.line}` : ''}`).join(', ')}` : '');
  if (canUpdateContext()) {
    const attachBtn = makeEl('button', 'link-btn', 'Attach node context to next prompt');
    attachBtn.type = 'button';
    attachBtn.addEventListener('click', () => void attachContextToPrompt(node.label || node.id, summaryText));
    list.appendChild(attachBtn);
  }
  if (canMessageHost()) {
    const askBtn = makeEl('button', 'link-btn', 'Ask agent to explain this node');
    askBtn.type = 'button';
    askBtn.addEventListener('click', () => void askAgent(`Explain the role, inputs, and outputs of "${node.label}" (${node.id}) in ${currentPayload?.title || 'this diagram'}.`));
    list.appendChild(askBtn);
  }
  actionsSec.appendChild(list);
  els.passportBody.appendChild(actionsSec);

  els.passportDrawer.hidden = false;
}

function renderDiagramMode(payload: ViewPayload) {
  if (payload.preset) currentPreset = payload.preset;
  els.presetSelect.value = currentPreset;
  els.presetSelect.hidden = false;
  els.searchInput.hidden = false;
  els.btnZoomOut.hidden = false;
  els.btnZoomFit.hidden = false;
  els.btnZoomIn.hidden = false;
  els.btnExportSvg.hidden = false;
  els.btnVisualCheck.hidden = false;

  const { viewport, layer } = createZoomableSvgViewport(payload.svg || '', (nodeId) => {
    const node = payload.nodes?.find((n) => n.id === nodeId);
    if (node) openInspector(node, layer);
  });

  els.btnZoomIn.onclick = () => { currentZoom = Math.min(4, currentZoom * 1.2); applyTransform(layer); };
  els.btnZoomOut.onclick = () => { currentZoom = Math.max(0.25, currentZoom * 0.85); applyTransform(layer); };
  els.btnZoomFit.onclick = () => { currentZoom = 1; panX = 0; panY = 0; applyTransform(layer); };
  els.searchInput.oninput = () => {
    const q = els.searchInput.value.trim().toLowerCase();
    layer.querySelectorAll('[data-node-id]').forEach((el) => {
      const id = (el.getAttribute('data-node-id') || '').toLowerCase();
      const label = (el.getAttribute('data-node-label') || '').toLowerCase();
      const hit = !q || id.includes(q) || label.includes(q);
      el.classList.toggle('studio-node-dimmed', !hit);
    });
  };

  els.modeView.appendChild(viewport);
}

function renderCompareMode(payload: ViewPayload) {
  els.btnZoomOut.hidden = false;
  els.btnZoomFit.hidden = false;
  els.btnZoomIn.hidden = false;

  const container = makeEl('div', 'content-scroll');
  const summary = payload.receipt?.summary || {};
  const kpi = makeEl('div', 'kpi-grid');
  for (const [label, val] of [
    ['Added', summary.added ?? 0],
    ['Removed', summary.removed ?? 0],
    ['Changed', summary.changed ?? 0],
    ['Total Rows', payload.changeRows?.length ?? 0],
  ]) {
    const card = makeEl('div', 'kpi-card');
    card.appendChild(makeEl('strong', undefined, String(val)));
    card.appendChild(makeEl('span', undefined, label));
    kpi.appendChild(card);
  }
  container.appendChild(kpi);

  const tabs = makeEl('div', 'tab-strip');
  const stageSlot = makeEl('div', 'card-box');
  const views: Array<[string, string | undefined]> = [
    ['Delta', payload.deltaSvg],
    ['Before (Base)', payload.baseSvg],
    ['After (Head)', payload.headSvg],
  ];

  const showTab = (idx: number) => {
    clearElement(stageSlot);
    tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === idx)));
    const markup = views[idx][1] || '<p>SVG snapshot not embedded in this comparison view.</p>';
    if (markup.includes('<svg')) {
      const { viewport, layer } = createZoomableSvgViewport(markup);
      els.btnZoomIn.onclick = () => { currentZoom = Math.min(4, currentZoom * 1.2); applyTransform(layer); };
      els.btnZoomOut.onclick = () => { currentZoom = Math.max(0.25, currentZoom * 0.85); applyTransform(layer); };
      els.btnZoomFit.onclick = () => { currentZoom = 1; panX = 0; panY = 0; applyTransform(layer); };
      stageSlot.appendChild(viewport);
    } else {
      stageSlot.innerHTML = markup;
    }
  };

  views.forEach(([label], idx) => {
    const btn = makeEl('button', 'tab-btn', label);
    btn.type = 'button';
    btn.setAttribute('aria-selected', String(idx === 0));
    btn.addEventListener('click', () => showTab(idx));
    tabs.appendChild(btn);
  });

  els.modeView.appendChild(tabs);
  container.appendChild(stageSlot);

  if (payload.changeRows?.length) {
    const tableCard = makeEl('div', 'card-box');
    const table = makeEl('table', 'data-table');
    table.innerHTML = '<thead><tr><th>Status</th><th>Kind</th><th>Element</th><th>Fields</th></tr></thead>';
    const tbody = makeEl('tbody');
    for (const row of payload.changeRows) {
      const tr = makeEl('tr');
      const statusCell = makeEl('td');
      statusCell.appendChild(makeEl('span', `sev-pill sev-${row.status}`, row.status));
      tr.appendChild(statusCell);
      tr.appendChild(makeEl('td', undefined, row.kind));
      tr.appendChild(makeEl('td', undefined, row.label || row.id));
      tr.appendChild(makeEl('td', undefined, (row.changedFields || []).join(', ') || '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableCard.appendChild(table);
    container.appendChild(tableCard);
  }

  els.modeView.appendChild(container);
  showTab(0);
}

function renderExplainerMode(payload: ViewPayload) {
  const scroll = makeEl('div', 'content-scroll');
  if (payload.answer) {
    const ans = makeEl('div', 'card-box answer-box');
    ans.appendChild(makeEl('strong', undefined, 'Conclusion'));
    if (payload.answer.summary) ans.appendChild(makeEl('p', undefined, payload.answer.summary));
    if (payload.answer.reasons?.length) {
      const ol = makeEl('ol');
      for (const r of payload.answer.reasons) ol.appendChild(makeEl('li', undefined, r));
      ans.appendChild(ol);
    }
    if (payload.answer.scope) ans.appendChild(makeEl('small', undefined, `Scope: ${payload.answer.scope}`));
    scroll.appendChild(ans);
  }

  for (const panel of payload.panels || []) {
    const card = makeEl('div', 'card-box');
    card.appendChild(makeEl('strong', undefined, panel.title));
    for (const block of panel.blocks || []) {
      if (block.type === 'prose' && block.text) {
        card.appendChild(makeEl('p', undefined, block.text));
      } else if (block.type === 'list' && Array.isArray(block.items)) {
        const ul = makeEl('ul');
        for (const item of block.items) ul.appendChild(makeEl('li', undefined, item));
        card.appendChild(ul);
      } else if (block.type === 'callout') {
        card.appendChild(makeEl('p', undefined, `${block.title ? `${block.title}: ` : ''}${block.text || ''}`));
      } else if (block.type === 'facts' && Array.isArray(block.entries)) {
        const dl = makeEl('div', 'passport-kv');
        for (const e of block.entries) dl.appendChild(makeEl('span', undefined, `${e.key}: ${e.value}`));
        card.appendChild(dl);
      } else if (block.type === 'metric') {
        card.appendChild(makeEl('p', undefined, `${block.label}: ${block.value ?? ''}${block.unit || ''}${block.limit !== undefined ? ` / ${block.limit}${block.unit || ''}` : ''}`));
      } else if (block.type === 'steps' && Array.isArray(block.items)) {
        const ol = makeEl('ol');
        for (const step of block.items) ol.appendChild(makeEl('li', undefined, `${step.text}${step.detail ? ` — ${step.detail}` : ''}`));
        card.appendChild(ol);
      } else if ((block.type === 'snippet' || block.type === 'diff') && block.text) {
        card.appendChild(makeEl('pre', 'code-block', block.text));
      } else if (block.type === 'diagram' && payload.diagrams?.[block.id]?.svg) {
        const host = makeEl('div', 'archify-svg-host');
        host.setAttribute('data-theme', currentTheme);
        host.innerHTML = payload.diagrams[block.id].svg;
        card.appendChild(host);
      }
    }
    for (const chartSvg of panel.charts || []) {
      const host = makeEl('div', 'archify-svg-host');
      host.setAttribute('data-theme', currentTheme);
      host.innerHTML = chartSvg;
      card.appendChild(host);
    }
    scroll.appendChild(card);
  }
  els.modeView.appendChild(scroll);
}

function renderStoryMode(payload: ViewPayload) {
  if (storyInterval !== null) {
    window.clearInterval(storyInterval);
    storyInterval = null;
  }
  storyIndex = 0;

  const steps: Array<{ title: string; caption?: string; nodes?: string[]; paneIndex?: number }> = [];
  if (payload.storyKind === 'stage' && payload.steps?.length) {
    payload.steps.forEach((s, idx) => steps.push({ title: s.title, caption: s.body || '', paneIndex: idx }));
  } else if (payload.storyPlan?.shots?.length) {
    for (const shot of payload.storyPlan.shots) {
      steps.push({
        title: shot.headline || shot.label || 'Step',
        caption: shot.caption || shot.annotations?.[0]?.body || '',
        nodes: shot.nodes || [],
      });
    }
  } else {
    steps.push({ title: payload.title, caption: 'Static story frame' });
  }

  const initialSvg = payload.svg || payload.panes?.[0]?.svg || '';
  const { viewport, layer } = createZoomableSvgViewport(initialSvg);
  els.modeView.appendChild(viewport);

  const bar = makeEl('div', 'story-bar');
  const prevBtn = makeEl('button', 'studio-btn', 'Prev');
  const playBtn = makeEl('button', 'studio-btn', 'Play');
  const nextBtn = makeEl('button', 'studio-btn', 'Next');
  const stepLabel = makeEl('strong', undefined, '');
  const caption = makeEl('span', 'story-caption', '');
  bar.append(prevBtn, playBtn, nextBtn, stepLabel, caption);
  els.modeView.appendChild(bar);

  const updateStep = (idx: number) => {
    storyIndex = (idx + steps.length) % steps.length;
    const step = steps[storyIndex];
    stepLabel.textContent = `${storyIndex + 1}/${steps.length} · ${step.title}`;
    caption.textContent = step.caption || '';
    if (step.nodes?.length) {
      const active = new Set(step.nodes);
      layer.querySelectorAll('[data-node-id]').forEach((el) => {
        const id = el.getAttribute('data-node-id') || '';
        el.classList.toggle('studio-node-selected', active.has(id));
        el.classList.toggle('studio-node-dimmed', !active.has(id));
      });
    } else {
      layer.querySelectorAll('[data-node-id]').forEach((el) => {
        el.classList.remove('studio-node-selected', 'studio-node-dimmed');
      });
    }
  };

  prevBtn.addEventListener('click', () => updateStep(storyIndex - 1));
  nextBtn.addEventListener('click', () => updateStep(storyIndex + 1));
  playBtn.addEventListener('click', () => {
    if (storyInterval !== null) {
      window.clearInterval(storyInterval);
      storyInterval = null;
      playBtn.textContent = 'Play';
    } else {
      playBtn.textContent = 'Pause';
      storyInterval = window.setInterval(() => updateStep(storyIndex + 1), 2400);
    }
  });
  updateStep(0);
}

function renderPrMode(payload: ViewPayload) {
  const scroll = makeEl('div', 'content-scroll');
  const stats = payload.receipt?.stats || {};
  const kpi = makeEl('div', 'kpi-grid');
  for (const [label, val] of [
    ['Files Changed', stats.filesChanged ?? 0],
    ['Additions', `+${stats.additions ?? 0}`],
    ['Deletions', `-${stats.deletions ?? 0}`],
    ['Views', payload.svgs?.length ?? 0],
  ]) {
    const card = makeEl('div', 'kpi-card');
    card.appendChild(makeEl('strong', undefined, String(val)));
    card.appendChild(makeEl('span', undefined, label));
    kpi.appendChild(card);
  }
  scroll.appendChild(kpi);

  if (payload.svgs?.length) {
    const card = makeEl('div', 'card-box');
    const select = makeEl('select', 'studio-select') as HTMLSelectElement;
    payload.svgs.forEach((s, i) => {
      const opt = makeEl('option', undefined, s.name) as HTMLOptionElement;
      opt.value = String(i);
      select.appendChild(opt);
    });
    const host = makeEl('div', 'archify-svg-host');
    host.setAttribute('data-theme', currentTheme);
    host.innerHTML = payload.svgs[0].svg;
    select.addEventListener('change', () => {
      host.innerHTML = payload.svgs?.[Number(select.value)]?.svg || '';
    });
    card.append(select, host);
    scroll.appendChild(card);
  }

  if (payload.markdown) {
    const mdCard = makeEl('div', 'card-box');
    mdCard.appendChild(makeEl('strong', undefined, 'PR Markdown'));
    mdCard.appendChild(makeEl('pre', 'code-block', payload.markdown));
    scroll.appendChild(mdCard);
  }
  els.modeView.appendChild(scroll);
}

function renderModuleGraphSvg(
  modules: NonNullable<ViewPayload['modules']>,
  edges: NonNullable<ViewPayload['moduleEdges']>,
) {
  const shown = modules.slice(0, 24);
  const cols = Math.max(2, Math.ceil(Math.sqrt(shown.length)));
  const cellW = 190;
  const cellH = 82;
  const pad = 28;
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const width = cols * cellW + pad * 2;
  const height = rows * cellH + pad * 2;
  const pos = new Map<string, { x: number; y: number }>();

  shown.forEach((m, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    pos.set(m.id, { x: pad + col * cellW + cellW / 2, y: pad + row * cellH + cellH / 2 });
  });

  const edgeSvg = edges
    .filter((e) => pos.has(e.from) && pos.has(e.to))
    .map((e) => {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="a-default" stroke-width="1.4" opacity="0.65" />`;
    })
    .join('');

  const escXml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

  const nodeSvg = shown
    .map((m) => {
      const p = pos.get(m.id)!;
      const x = p.x - 78;
      const y = p.y - 24;
      const idEsc = escXml(m.id);
      const labelEsc = escXml(m.label);
      const shortEsc = escXml(m.label.slice(0, 20));
      return `<g data-node-id="${idEsc}" data-node-label="${labelEsc}"><rect x="${x}" y="${y}" width="156" height="48" rx="7" class="c-mask"/><rect x="${x}" y="${y}" width="156" height="48" rx="7" class="c-backend" stroke-width="1.4"/><text x="${p.x}" y="${p.y - 4}" class="t-primary" font-size="11" font-weight="600" text-anchor="middle">${shortEsc}</text><text x="${p.x}" y="${p.y + 13}" class="t-muted" font-size="9" text-anchor="middle">in:${m.fanIn} out:${m.fanOut} · ${m.files}f</text></g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Module coupling graph">${edgeSvg}${nodeSvg}</svg>`;
}

function renderCodeAnalysisMode(payload: ViewPayload) {
  const scroll = makeEl('div', 'content-scroll');
  const counts = payload.counts || {};
  const kpi = makeEl('div', 'kpi-grid');
  for (const [label, val] of [
    ['Findings', counts.findings ?? payload.findings?.length ?? 0],
    ['Errors', counts.error ?? 0],
    ['Warnings', counts.warning ?? 0],
    ['Modules', payload.modules?.length ?? 0],
  ]) {
    const card = makeEl('div', 'kpi-card');
    card.appendChild(makeEl('strong', undefined, String(val)));
    card.appendChild(makeEl('span', undefined, label));
    kpi.appendChild(card);
  }
  scroll.appendChild(kpi);

  if (payload.modules?.length) {
    const graphCard = makeEl('div', 'card-box');
    graphCard.appendChild(makeEl('strong', undefined, 'Module Coupling Map'));
    const svg = renderModuleGraphSvg(payload.modules, payload.moduleEdges || []);
    const { viewport } = createZoomableSvgViewport(svg);
    viewport.style.minHeight = '240px';
    graphCard.appendChild(viewport);
    scroll.appendChild(graphCard);
  }

  const findingsCard = makeEl('div', 'card-box');
  findingsCard.appendChild(makeEl('strong', undefined, `Diagnostics (${payload.findings?.length ?? 0})`));
  const table = makeEl('table', 'data-table');
  table.innerHTML = '<thead><tr><th>Severity</th><th>Rule</th><th>Message</th><th>Actions</th></tr></thead>';
  const tbody = makeEl('tbody');

  for (const f of payload.findings || []) {
    const tr = makeEl('tr');
    const sevTd = makeEl('td');
    sevTd.appendChild(makeEl('span', `sev-pill sev-${f.severity}`, f.severity));
    tr.appendChild(sevTd);
    tr.appendChild(makeEl('td', undefined, `${f.id}\n${f.code}`));
    tr.appendChild(makeEl('td', undefined, f.message));
    const actTd = makeEl('td');
    const file = f.subject?.file || f.subject?.path;
    if (file) {
      const openBtn = makeEl('button', 'studio-btn studio-btn-sm', `Open ${file}`);
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => void openSourceInAntigravity(file, f.subject?.line));
      actTd.appendChild(openBtn);
    }
    if (canMessageHost()) {
      const fixBtn = makeEl('button', 'studio-btn studio-btn-sm', 'Refactor');
      fixBtn.type = 'button';
      fixBtn.addEventListener('click', () => void askAgent(`Investigate and propose a scoped refactoring for Archify Code Analysis finding ${f.id} (${f.code}): ${f.message}`));
      actTd.appendChild(fixBtn);
    }
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  findingsCard.appendChild(table);
  scroll.appendChild(findingsCard);
  els.modeView.appendChild(scroll);
}

function renderPayload(payload: ViewPayload) {
  currentPayload = payload;
  selectedNodeId = null;
  els.passportDrawer.hidden = true;
  els.empty.hidden = true;
  els.modeView.hidden = false;
  clearElement(els.modeView);

  els.searchInput.hidden = true;
  els.presetSelect.hidden = true;
  els.btnZoomOut.hidden = true;
  els.btnZoomFit.hidden = true;
  els.btnZoomIn.hidden = true;
  els.btnExportSvg.hidden = true;
  els.btnVisualCheck.hidden = true;

  els.title.textContent = payload.title || 'Archify Studio';
  els.subtitle.textContent = payload.subtitle || payload.artifactPath || '';
  els.badge.textContent = payload.diagramType || payload.kind;
  els.badge.hidden = false;

  if (payload.kind === 'diagram') renderDiagramMode(payload);
  else if (payload.kind === 'compare') renderCompareMode(payload);
  else if (payload.kind === 'explainer') renderExplainerMode(payload);
  else if (payload.kind === 'story') renderStoryMode(payload);
  else if (payload.kind === 'pr') renderPrMode(payload);
  else if (payload.kind === 'code-analysis') renderCodeAnalysisMode(payload);
}

async function refreshLibrary() {
  try {
    const res = await app.callServerTool({ name: 'app_list_artifacts', arguments: {} });
    const list: ArtifactSummary[] = (res.structuredContent as any)?.artifacts || [];
    clearElement(els.libraryList);
    if (!list.length) {
      els.libraryList.appendChild(makeEl('p', 'studio-subtitle', 'No artifacts recorded yet.'));
      return;
    }
    for (const item of list) {
      const btn = makeEl('button', 'library-item');
      btn.type = 'button';
      if (currentPayload?.artifactPath === item.outputPath) btn.setAttribute('aria-current', 'true');
      btn.appendChild(makeEl('strong', undefined, item.title));
      btn.appendChild(makeEl('small', undefined, `${item.diagramType || item.kind} · ${item.outputPath}`));
      btn.addEventListener('click', () => {
        void loadArtifact({ artifactId: item.id, artifactPath: item.outputPath });
      });
      els.libraryList.appendChild(btn);
    }
  } catch (error: any) {
    showBanner(`Failed to list artifacts: ${error?.message || error}`);
  }
}

async function loadArtifact(args: { artifactId?: string; artifactPath?: string; kind?: string }) {
  try {
    const res = await app.callServerTool({ name: 'app_load_artifact', arguments: args });
    const data = res.structuredContent as ViewPayload | undefined;
    if (data?.kind) renderPayload(data);
    else showBanner('No renderable view returned for this artifact.');
  } catch (error: any) {
    showBanner(`Could not load artifact: ${error?.message || error}`);
  }
}

// Register all handlers BEFORE connect() per Antigravity MCP Apps requirement.
app.ontoolinput = ({ arguments: args }) => {
  const hint = (args as any)?.outputPath || (args as any)?.artifactPath || '';
  if (hint) showBanner(`Running Archify for ${hint}…`, 0);
};

app.ontoolresult = (result) => {
  els.banner.hidden = true;
  const sc = result?.structuredContent as any;
  if (!sc) return;
  if (sc.viewPayload) {
    renderPayload(sc.viewPayload as ViewPayload);
    return;
  }
  const artifactPath = sc.artifactPath || sc.artifact || sc.html || sc.output;
  if (artifactPath && typeof artifactPath === 'string') {
    void loadArtifact({ artifactPath, kind: sc.kind });
  } else if (Array.isArray(sc.artifacts) && sc.artifacts.length) {
    els.libraryDrawer.hidden = false;
    void refreshLibrary();
    void loadArtifact({ artifactId: sc.artifacts[0].id, artifactPath: sc.artifacts[0].outputPath });
  } else {
    els.libraryDrawer.hidden = false;
    void refreshLibrary();
  }
};

app.onhostcontextchanged = (ctx) => applyHostContext(ctx);
app.ontoolcancelled = () => showBanner('Tool execution cancelled.');

els.btnTheme.addEventListener('click', () => {
  applyThemeState(currentTheme === 'dark' ? 'light' : 'dark');
  void app.callServerTool({
    name: 'app_save_preferences',
    arguments: { theme: currentTheme, preset: currentPreset },
  }).catch(() => {});
});

els.presetSelect.addEventListener('change', () => {
  currentPreset = els.presetSelect.value;
  applyThemeState(currentTheme);
  void app.callServerTool({
    name: 'app_save_preferences',
    arguments: { preset: currentPreset },
  }).catch(() => {});
});

els.btnLibrary.addEventListener('click', () => {
  els.libraryDrawer.hidden = !els.libraryDrawer.hidden;
  if (!els.libraryDrawer.hidden) void refreshLibrary();
});

els.btnRefreshLibrary.addEventListener('click', () => void refreshLibrary());
els.btnOpenLibraryEmpty.addEventListener('click', () => {
  els.libraryDrawer.hidden = false;
  void refreshLibrary();
});
els.btnClosePassport.addEventListener('click', () => {
  els.passportDrawer.hidden = true;
});

els.btnExportSvg.addEventListener('click', async () => {
  if (!currentPayload?.artifactPath) return;
  showBanner('Exporting standalone SVG…', 0);
  try {
    const res = await app.callServerTool({
      name: 'app_export_artifact',
      arguments: {
        action: 'export-svg',
        artifactPath: currentPayload.artifactPath,
        theme: currentTheme,
      },
    });
    const out = (res.structuredContent as any)?.outputPath;
    showBanner(out ? `Exported SVG to ${out}` : 'SVG export completed.');
  } catch (error: any) {
    showBanner(`Export failed: ${error?.message || error}`);
  }
});

els.btnVisualCheck.addEventListener('click', async () => {
  if (!currentPayload?.artifactPath) return;
  showBanner('Running Chromium visual-check…', 0);
  try {
    const res = await app.callServerTool({
      name: 'app_export_artifact',
      arguments: {
        action: 'visual-check',
        artifactPath: currentPayload.artifactPath,
      },
    });
    const sc = res.structuredContent as any;
    showBanner(sc?.ok ? `Visual check passed (${sc.screenshots?.length || 0} captures).` : `Visual check finished: ${sc?.error || 'see output'}`);
  } catch (error: any) {
    showBanner(`Visual check failed: ${error?.message || error}`);
  }
});

async function bootstrap() {
  await app.connect();
  applyHostContext(app.getHostContext());
  void refreshLibrary();
}

void bootstrap();
