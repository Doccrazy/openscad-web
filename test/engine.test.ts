import { describe, expect, it } from 'vitest';
import Module from 'manifold-3d';
import { OpenSCADEngine } from '../src/engine';

describe('engine', async () => {
  const wasm = await Module();
  wasm.setup();
  const files: Record<string, string> = {
    '/lib/shapes.scad': 'module ring(r=5, w=1) { difference() { circle(r); circle(r-w); } }\nfunction twice(x) = 2 * x;\nlib_var = 42;\ncube(1000); // geometry in used files is ignored',
    '/lib/consts.scad': 'size = 7;\ninclude <nested.scad>',
    '/lib/nested.scad': 'nested = "yes";',
    '/models/tri.stl': 'solid t\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid',
    '/models/height.dat': '1 2 3\n4 5 6\n7 8 9',
  };
  const requested: string[] = [];
  const engine = new OpenSCADEngine({
    wasm,
    resolveFile: async (path, relativeTo) => {
      const base = relativeTo ? relativeTo.slice(0, relativeTo.lastIndexOf('/') + 1) : '/';
      const full = path.startsWith('/') ? path : base + path;
      requested.push(full);
      const data = files[full] ?? files['/lib/' + path];
      return data === undefined ? null : { path: full in files ? full : '/lib/' + path, data };
    },
  });

  it('resolves include and use asynchronously', async () => {
    const r = await engine.render(
      'use <lib/shapes.scad>\ninclude <lib/consts.scad>\necho(twice(size), nested, lib_var);\nlinear_extrude(1) ring();',
      { file: '/main.scad' },
    );
    const echo = r.messages.filter((m) => m.level === 'echo').map((m) => m.text);
    // lib_var is not visible through use<>
    expect(echo).toEqual(['14, "yes", undef']);
    expect(r.scene.meshes.length).toBe(1);
    expect(r.scene.bbox!.max[0]).toBeCloseTo(5);
  });

  it('imports STL and height maps', async () => {
    const r = await engine.render('import("models/tri.stl"); translate([5,0,0]) surface("models/height.dat");', { file: '/main.scad' });
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(r.scene.stats.triangles).toBeGreaterThan(10);
  });

  it('reports missing files with line numbers', async () => {
    const r = await engine.render('\ninclude <missing.scad>\ncube(1);', { file: '/main.scad' });
    const w = r.messages.find((m) => m.level === 'warning');
    expect(w?.text).toContain('missing.scad');
    expect(w?.line).toBe(2);
  });

  it('reports syntax errors with location', async () => {
    const r = await engine.render('cube(1);\nsphere(2;\n');
    expect(r.failed).toBe(true);
    expect(r.messages[0]).toMatchObject({ level: 'error', line: 2 });
  });

  it('customizer overrides', async () => {
    const r = await engine.render('w = 10; // [1:100]\ncube(w);', { overrides: { w: 3 } });
    expect(r.scene.bbox!.max).toEqual([3, 3, 3]);
  });

  it('handles heavy scenes quickly (lazy unions)', async () => {
    const t0 = performance.now();
    const r = await engine.render('for (x=[0:19], y=[0:19]) translate([x*3, y*3, 0]) sphere(1.6, $fn=24);');
    const dt = performance.now() - t0;
    expect(r.scene.stats.triangles).toBeGreaterThan(100000);
    expect(dt).toBeLessThan(3000);
    const t1 = performance.now();
    const ex = await engine.render('difference() { cube([60,60,2]); for (x=[0:19], y=[0:19]) translate([x*3, y*3, 0]) cylinder(r=1, h=5, center=true, $fn=16); }', { exact: true });
    expect(ex.scene.stats.triangles).toBeGreaterThan(1000);
    expect(performance.now() - t1).toBeLessThan(3000);
  });
});
