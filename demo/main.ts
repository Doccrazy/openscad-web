import wasmUrl from 'manifold-3d/manifold.wasm?url';
import fontRegular from '@fontsource/arimo/files/arimo-latin-400-normal.woff?url';
import fontBold from '@fontsource/arimo/files/arimo-latin-700-normal.woff?url';
import fontItalic from '@fontsource/arimo/files/arimo-latin-400-italic.woff?url';
import fontBoldItalic from '@fontsource/arimo/files/arimo-latin-700-italic.woff?url';
import {
  CancelledError,
  CustomizerPanel,
  EngineMessage,
  OpenSCADWorkerClient,
  RenderResult,
  Value,
  Viewer,
  exportBinarySTL,
  extractParameters,
  parseParameters,
} from '../src';
import type { FontSource } from '../src';
import { CodeEditor } from './editor';
import { EXAMPLES } from './examples';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORAGE_KEY = 'openscad-web:code';

// -- persistence helpers --------------------------------------------------------------

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

async function encodeShare(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code);
  let data = bytes;
  if (typeof CompressionStream !== 'undefined') {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    data = new Uint8Array(await new Response(s).arrayBuffer());
  }
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decodeShare(s: string): Promise<string | null> {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (typeof DecompressionStream !== 'undefined') {
      const st = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(st).text();
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// -- theme ----------------------------------------------------------------------------

function currentTheme(): 'light' | 'dark' {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const savedTheme = load('openscad-web:theme');
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

// -- engine ---------------------------------------------------------------------------

const abs = (u: string): string => new URL(u, location.href).href;
const fonts: FontSource[] = [
  { family: 'Liberation Sans', source: abs(fontRegular) },
  { family: 'Liberation Sans', bold: true, source: abs(fontBold) },
  { family: 'Liberation Sans', italic: true, source: abs(fontItalic) },
  { family: 'Liberation Sans', bold: true, italic: true, source: abs(fontBoldItalic) },
];

const client = new OpenSCADWorkerClient({
  createWorker: () => new Worker(new URL('../src/engine/worker.ts', import.meta.url), { type: 'module' }),
  wasmUrl: abs(wasmUrl),
  fonts,
  // include <...> / import() are resolved relative to this page
  resolveFile: async (path, relativeTo, binary) => {
    try {
      const url = new URL(path, relativeTo ?? location.href).href;
      const res = await fetch(url);
      if (!res.ok) return null;
      return { path: url, data: binary ? new Uint8Array(await res.arrayBuffer()) : await res.text() };
    } catch {
      return null;
    }
  },
});

// -- viewer ---------------------------------------------------------------------------

const rendererParam = new URLSearchParams(location.search).get('renderer');
const viewer = new Viewer($('viewer'), {
  theme: currentTheme(),
  renderer: rendererParam === 'canvas2d' || rendererParam === 'webgl2' ? rendererParam : 'auto',
});
$('backend').textContent = viewer.backend === 'webgl2' ? 'WebGL2 · depth-peeled transparency' : 'Canvas 2D (no WebGL2)';

// -- editor + customizer ------------------------------------------------------------------

const status = $('status');
const stats = $('stats');
const busy = $('busy');
const consoleEl = $('console');
let firstRender = true;
let lastResult: RenderResult | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

const customizer = new CustomizerPanel($('cz-body'), {
  onChange: () => schedule(0),
});

async function initialCode(): Promise<string> {
  const m = /[#&]code=([^&]+)/.exec(location.hash);
  if (m) {
    const c = await decodeShare(m[1]);
    if (c) return c;
  }
  return load(STORAGE_KEY) ?? EXAMPLES[0].code;
}

const editor = new CodeEditor($('editor'), await initialCode(), (code) => {
  save(STORAGE_KEY, code);
  const params = parseParameters(code);
  if (params) customizer.setParameters(params);
  if (($('auto') as HTMLInputElement).checked) schedule(250);
}, [
  { key: 'F5', run: () => (schedule(0), true) },
  { key: 'F6', run: () => (runRender(true), true) },
  { key: 'Mod-s', run: () => (save(STORAGE_KEY, editor.code), schedule(0), true) },
]);
customizer.setParameters(extractParameters(editor.code));

function schedule(ms: number): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => runRender(false), ms);
}

async function runRender(exact: boolean): Promise<RenderResult | null> {
  clearTimeout(debounce);
  busy.hidden = false;
  status.textContent = exact ? 'Rendering (exact)…' : 'Rendering…';
  try {
    const result = await client.render(editor.code, { overrides: customizer.overrides as Record<string, Value>, exact });
    lastResult = result;
    // keep showing the last good model while the code has errors (e.g. while typing)
    if (!(result.failed && result.scene.meshes.length === 0)) {
      viewer.setScene(result.scene, { fit: firstRender && result.scene.meshes.length > 0 });
      if (result.scene.meshes.length) firstRender = false;
    }
    showMessages(result.messages);
    editor.setMessages(result.messages);
    const t = result.timings;
    const errors = result.messages.filter((m) => m.level === 'error').length;
    status.innerHTML = '';
    const s = document.createElement('span');
    if (errors) {
      s.className = 'err';
      s.textContent = `${errors} error${errors > 1 ? 's' : ''}`;
    } else s.textContent = exact ? 'Rendered (exact)' : 'Preview';
    status.appendChild(s);
    stats.textContent =
      `${result.scene.stats.triangles.toLocaleString()} triangles · eval ${t.evalMs.toFixed(0)} ms · ` +
      `geometry ${t.geometryMs.toFixed(0)} ms · total ${t.totalMs.toFixed(0)} ms`;
    busy.hidden = true;
    return result;
  } catch (e) {
    if (e instanceof CancelledError) return null;
    busy.hidden = true;
    status.textContent = 'Engine error';
    showMessages([{ level: 'error', text: String((e as Error).message ?? e) }]);
    return null;
  }
}

function showMessages(messages: EngineMessage[]): void {
  consoleEl.textContent = '';
  const counts = { error: 0, warning: 0, echo: 0 } as Record<string, number>;
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    counts[m.level] = (counts[m.level] ?? 0) + 1;
    const row = document.createElement('div');
    row.className = `msg ${m.level}`;
    const lvl = document.createElement('span');
    lvl.className = 'lvl';
    lvl.textContent = m.level.toUpperCase() + ':';
    row.appendChild(lvl);
    const text = document.createElement('span');
    text.textContent = m.text;
    row.appendChild(text);
    if (m.line !== undefined) {
      const loc = document.createElement('span');
      loc.className = 'loc';
      const isMain = m.file === undefined;
      loc.textContent = `${isMain ? '' : (m.file!.split('/').pop() + ':')}line ${m.line}`;
      if (isMain && m.pos !== undefined) loc.addEventListener('click', () => editor.goto(m.pos!));
      row.appendChild(loc);
    }
    frag.appendChild(row);
  }
  consoleEl.appendChild(frag);
  $('counts').textContent = [
    counts.error ? `${counts.error} error(s)` : '',
    counts.warning ? `${counts.warning} warning(s)` : '',
    counts.echo ? `${counts.echo} echo` : '',
  ].filter(Boolean).join(' · ');
}

// -- toolbar ---------------------------------------------------------------------------

const examples = $<HTMLSelectElement>('examples');
examples.innerHTML = '<option value="">Examples…</option>' + EXAMPLES.map((e, i) => `<option value="${i}">${e.name}</option>`).join('');
examples.addEventListener('change', () => {
  const ex = EXAMPLES[Number(examples.value)];
  examples.value = '';
  if (!ex) return;
  firstRender = true;
  customizer.reset();
  editor.setCode(ex.code);
  schedule(0);
});

$('btn-preview').addEventListener('click', () => runRender(false));
$('btn-render').addEventListener('click', () => runRender(true));
$('btn-stl').addEventListener('click', async () => {
  const r = await runRender(true);
  if (!r) return;
  const buf = exportBinarySTL(r.scene);
  if (buf.byteLength <= 84) {
    showMessages([...r.messages, { level: 'warning', text: 'Nothing to export: the model has no 3D geometry.' }]);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
  a.download = 'model.stl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btn-share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#code=${await encodeShare(editor.code)}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = 'Link copied to clipboard';
  } catch {
    status.textContent = 'Link is in the address bar';
  }
});
$('btn-theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  save('openscad-web:theme', next);
  viewer.setTheme(next);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => viewer.setTheme(currentTheme()));
$('btn-clear').addEventListener('click', () => {
  consoleEl.textContent = '';
  $('counts').textContent = '';
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  b.addEventListener('click', () => viewer.setView(b.dataset.view as never));
}
$('btn-fit').addEventListener('click', () => viewer.fit());
const projBtn = $('btn-proj');
projBtn.addEventListener('click', () => {
  const ortho = viewer.getOptions().projection === 'perspective';
  viewer.setProjection(ortho ? 'orthographic' : 'perspective');
  projBtn.textContent = ortho ? 'Ortho' : 'Persp';
});
for (const [id, key] of [['btn-edges', 'showEdges'], ['btn-grid', 'showGrid'], ['btn-axes', 'showAxes']] as const) {
  const b = $(id);
  b.addEventListener('click', () => {
    const on = !viewer.getOptions()[key];
    viewer.setOptions({ [key]: on });
    b.classList.toggle('on', on);
  });
}

$('cz-reset').addEventListener('click', () => customizer.reset());
$('cz-toggle').addEventListener('click', () => $('customizer').classList.toggle('collapsed'));

// resizable split
const gutter = $('gutter');
gutter.addEventListener('pointerdown', (e) => {
  gutter.setPointerCapture(e.pointerId);
  gutter.classList.add('dragging');
  const move = (ev: PointerEvent): void => {
    const pct = Math.min(80, Math.max(15, (ev.clientX / window.innerWidth) * 100));
    $('left').style.width = `${pct}%`;
  };
  const up = (): void => {
    gutter.classList.remove('dragging');
    gutter.removeEventListener('pointermove', move);
    gutter.removeEventListener('pointerup', up);
  };
  gutter.addEventListener('pointermove', move);
  gutter.addEventListener('pointerup', up);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') {
    e.preventDefault();
    schedule(0);
  } else if (e.key === 'F6') {
    e.preventDefault();
    runRender(true);
  }
});

// expose for debugging / embedding experiments
Object.assign(window, { viewer, client, editor, lastResult: () => lastResult });

runRender(false);
