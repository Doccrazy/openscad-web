# openscad-web

A standalone OpenSCAD implementation for the web: a TypeScript interpreter for the OpenSCAD language, a CSG
geometry backend built on [manifold-3d](https://github.com/elalish/manifold) (WASM), and a dependency-free
WebGL2 viewer with order-independent transparency. No OpenSCAD code or binary is used.

The demo page (`demo/`) has a CodeMirror editor with live preview, a console with clickable diagnostics,
the OpenSCAD customizer, exact render and STL export.

```sh
npm install
npm run dev        # demo at http://localhost:5173
npm test           # unit + integration tests (Node, no browser needed)
npm run build      # demo  -> dist-demo/
npm run build:lib  # library -> dist/ (ESM + .d.ts)
```

## Goals and trade-offs

- **Speed over exact CSG.** In preview mode (the default), plain unions are *lazy*: overlapping solids are
  collected and only merged when an operation needs a single solid (`difference`, `intersection`,
  `minkowski`, …). This is visually identical for opaque objects and can be much faster (a recursive tree
  with ~1000 cylinders: 818 ms → 41 ms). Pass `exact: true` (the demo's *Render*/F6 button) for a fully
  unioned, manifold result, e.g. for STL export.
- **Incremental re-evaluation.** Every CSG subtree is cached by a structural hash. When you edit code or
  move a customizer slider, only the changed branches are recomputed (typically 5–20 ms).
- **Correct transparency.** `color(c, alpha)`, `#` and `%` are rendered with depth peeling (exact
  order-independent transparency), not sorted or additive blending.
- **Colors survive CSG.** Manifold tracks which input mesh each output triangle came from, so colors work
  through `difference()`/`intersection()`. Cut surfaces from uncolored subtrahends are shown in OpenSCAD's
  green "cut" color.
- **No 1:1 OpenSCAD preview parity.** Unlike OpenSCAD's OpenCSG preview, there are no z-fighting or
  convexity artifacts.

## Architecture

Each layer is usable on its own and only depends on the layers above it:

| Module             | What it does                                                                     | Runs in            |
| ------------------ | -------------------------------------------------------------------------------- | ------------------ |
| `src/lang`         | Lexer, parser, AST (keeps comments for tooling)                                  | anywhere           |
| `src/eval`         | Interpreter → plain-JSON CSG tree (`GeomNode`)                                   | anywhere           |
| `src/geometry`     | CSG tree → triangle meshes via manifold-3d; importers; STL export                | anywhere with WASM |
| `src/engine`       | Pipeline (parse → eval → geometry), async file loading, Web Worker + client      | worker / Node      |
| `src/customizer`   | Customizer parameter extraction (OpenSCAD comment syntax) and a DOM panel        | anywhere / DOM     |
| `src/viewer`       | WebGL2 viewer (depth peeling, SSAA, edges, grid) with a Canvas 2D fallback       | DOM                |

```
source ──parse──▶ AST ──Interpreter──▶ GeomNode tree ──GeometryEvaluator──▶ SceneData ──▶ Viewer
                                         (JSON)          (manifold, cached)    (Float32Arrays,
                                                                                transferable)
```

### Using the engine in a Web Worker (recommended for UIs)

```ts
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { OpenSCADWorkerClient, Viewer, CancelledError } from 'openscad-web';

const client = new OpenSCADWorkerClient({
  createWorker: () => new Worker(new URL('openscad-web/worker', import.meta.url), { type: 'module' }),
  wasmUrl,
  fonts: [{ family: 'Liberation Sans', source: '/fonts/LiberationSans-Regular.ttf' }],
  resolveFile: async (path, relativeTo, binary) => {
    /* return { path: canonicalPath, data: string | Uint8Array } or null */
  },
});
const viewer = new Viewer(document.getElementById('view')!, { theme: 'dark' });

try {
  const result = await client.render(code, { overrides: { width: 20 } });
  viewer.setScene(result.scene, { fit: true });
  console.log(result.messages); // echo / warnings / errors with line + col
} catch (e) {
  if (!(e instanceof CancelledError)) throw e; // superseded by a newer render
}
```

`render()` calls supersede each other: only the latest request is processed, and a long-running obsolete
job is aborted by restarting the worker (`restartAfterMs`, default 1.5 s).

### Using the engine directly (Node, VS Code extension host, tests)

```ts
import Module from 'manifold-3d';
import { OpenSCADEngine, exportBinarySTL } from 'openscad-web';

const wasm = await Module();
wasm.setup();
const engine = new OpenSCADEngine({ wasm, resolveFile: async (p, rel) => /* read from disk */ null });
const { scene, messages } = await engine.render(source, { file: '/abs/path/main.scad', exact: true });
fs.writeFileSync('out.stl', Buffer.from(exportBinarySTL(scene)));
```

### VS Code integration sketch

- Run `OpenSCADEngine` in the extension host (Node) or in the webview's worker; implement `resolveFile`
  with `vscode.workspace.fs` so `include`/`use`/`import()` work with workspace files, and call
  `invalidateFiles()` on file-change events.
- Show `Viewer` and `CustomizerPanel` in a webview; send `SceneData` (all `Float32Array`s, transferable)
  via `postMessage`.
- Map `RenderResult.messages` (with `file`, `line`, `col`) to a `DiagnosticCollection`.
- `parseParameters()` and `tokenize()` (which preserves comments) can power hover, outline or
  customizer features without evaluating anything.

### Lower-level pieces

```ts
import { parse, evaluate, GeometryEvaluator, extractParameters } from 'openscad-web';

const { program, comments } = parse(src);            // AST
const { nodes, messages } = evaluate(src);            // CSG tree (no WASM needed)
const geo = new GeometryEvaluator(wasm);              // keep it around for caching
const { scene } = geo.evaluate(nodes, { exact: false });
const params = extractParameters(src);                // customizer parameters
```

## Language support

- Full expression language: vectors, ranges, list comprehensions (`for`, C-style `for`, `if/else`, `let`,
  `each`), function literals, `let`/`assert`/`echo` expressions, recursion with tail-call elimination
  (no stack overflow on deep tail recursion), dynamic scoping of `$` variables, OpenSCAD's assignment hoisting.
- Modules with `children()`, `$children`, `parent_module()`, modifiers `! # % *`.
- `include <>` / `use <>` with asynchronous resolution (re-evaluates once files are loaded).
- Built-in functions: math/trig (degree-exact), `str`, `chr`, `ord`, `len`, `concat`, `lookup`, `search`,
  `rands`, `norm`, `cross`, `min`/`max`, `is_*`, `version`, `object` …
- Built-in modules: `cube sphere cylinder polyhedron square circle polygon text translate rotate scale mirror
  multmatrix color resize offset union difference intersection hull minkowski render linear_extrude
  rotate_extrude projection import surface for intersection_for let echo assert children`.
- `text()` uses opentype.js; the demo bundles Arimo (metric-compatible with OpenSCAD's default
  Liberation Sans).
- `import()` supports STL (ASCII/binary), OFF and OBJ; `surface()` supports `.dat` height maps.
  Inconsistently oriented polyhedra are flipped automatically; non-manifold meshes are displayed but
  ignored by booleans (with a warning).

Known gaps: DXF/SVG/3MF import, PNG height maps, `roof()`, `textmetrics()`, and some edge cases of
OpenSCAD's warning messages and numeric formatting.

## Customizer

Parameters follow OpenSCAD's conventions: top-level assignments with literal values before the first
`module` definition, `/* [Tab] */` groups (`[Hidden]` hides, `[Global]` shows everywhere), a `// comment`
on the line above as description, and a trailing widget hint:

```openscad
/* [Size] */
// Outer width
width = 60;       // [20:200]           slider
wall = 2;         // [1:0.5:6]          slider with step
shape = "round";  // [round, square]    dropdown
quality = 2;      // [1:Low, 2:High]    dropdown with labels
label = "hi";     // 8                  max length
size = [1, 2, 3]; // [0:10]             vector
hollow = true;    //                    checkbox
```

`toParameterSet()` / `fromParameterSet()` read and write OpenSCAD's JSON parameter-set format.

## Viewer

- WebGL2, no dependencies. Opaque pass, then N depth-peeling layers (default 8, 4 while interacting),
  composited front-to-back, then 2× supersampling on low-DPI screens (dropped while interacting).
- Flat shading from screen-space derivatives, feature edges (> 25° dihedral), adaptive grid, axes, light and
  dark themes (`ViewerTheme` is fully customizable, including default/cut/highlight colors).
- Turntable camera (Z up), perspective/orthographic, view presets, fit-to-model (double-click), touch support.
- Falls back to a Canvas 2D painter's-algorithm renderer when WebGL2 is unavailable
  (`renderer: 'auto' | 'webgl2' | 'canvas2d'`).
