import { beforeAll, describe, expect, it } from 'vitest';
import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';
import { evaluate } from '../src/eval';
import { GeometryEvaluator } from '../src/geometry';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function run(src: string, geo = new GeometryEvaluator(wasm)) {
  const r = evaluate(src);
  const errs = r.messages.filter((m) => m.level === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.text).join('\n'));
  const { scene, warnings } = geo.evaluate(r.nodes);
  return { scene, warnings, messages: r.messages };
}

function volumeOf(positions: Float32Array): number {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('geometry', () => {
  it('cube', () => {
    const { scene } = run('cube(10);');
    expect(scene.meshes.length).toBe(1);
    expect(scene.stats.triangles).toBe(12);
    expect(volumeOf(scene.meshes[0].positions)).toBeCloseTo(1000, 3);
  });
  it('primitives are closed and outward facing', () => {
    for (const src of ['sphere(5, $fn=16);', 'cylinder(h=3, r=2, $fn=12);', 'cylinder(h=3, r1=2, r2=0, $fn=12);', 'cylinder(h=3, r1=0, r2=2, center=true, $fn=7);',
      'polyhedron(points=[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[5,5,5]], faces=[[0,1,4],[1,2,4],[2,3,4],[3,0,4],[1,0,3],[2,1,3]]);',
      'polyhedron(points=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]], faces=[[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]);']) {
      const { scene, warnings } = run(src);
      expect(warnings, src).toEqual([]);
      expect(volumeOf(scene.meshes[0].positions), src).toBeGreaterThan(0);
    }
  });
  it('difference keeps colors and marks cut faces', () => {
    const { scene } = run('color("red") difference() { cube(10, center=true); cylinder(h=20, r=3, center=true); }');
    const m = scene.meshes[0];
    expect(m.materials.map((x) => x.kind).sort()).toEqual(['color']);
    const { scene: s2 } = run('difference() { cube(10, center=true); color("blue") cylinder(h=20, r=3, center=true); cylinder(h=20, r=1, center=true); }');
    expect(s2.meshes[0].materials.map((x) => x.kind).sort()).toEqual(['color', 'default']);
    const { scene: s3 } = run('difference() { cube(10, center=true); cylinder(h=20, r=3, center=true); }');
    expect(s3.meshes[0].materials.map((x) => x.kind).sort()).toEqual(['cut', 'default']);
  });
  it('2D and extrusions', () => {
    const { scene } = run('linear_extrude(height=10, twist=90, scale=0.5) square(5, center=true);');
    expect(volumeOf(scene.meshes[0].positions)).toBeGreaterThan(100);
    const r2 = run('rotate_extrude($fn=32) translate([10,0]) circle(2, $fn=16);');
    expect(volumeOf(r2.scene.meshes[0].positions)).toBeGreaterThan(700);
    const r3 = run('difference() { square(10); offset(r=1) square(2); }');
    expect(r3.scene.meshes[0].dim).toBe(2);
  });
  it('hull, minkowski, projection, resize', () => {
    expect(run('hull() { cube(1); translate([5,0,0]) sphere(1); }').scene.stats.triangles).toBeGreaterThan(10);
    expect(run('minkowski() { cube(5); sphere(1, $fn=8); }').scene.stats.triangles).toBeGreaterThan(10);
    expect(run('minkowski() { square(5); circle(1, $fn=8); }').scene.meshes[0].dim).toBe(2);
    expect(run('projection() sphere(5);').scene.meshes[0].dim).toBe(2);
    const r = run('resize([20,0,0], auto=true) cube([10,5,5]);');
    expect(r.scene.bbox!.max).toEqual([20, 10, 10]);
  });
  it('modifiers produce overlays', () => {
    const { scene } = run('difference() { cube(10); #cylinder(h=30, r=2); %sphere(3); }');
    expect(scene.meshes.map((m) => m.role)).toEqual(['model', 'highlight', 'background']);
  });
  it('caches subtrees between runs', () => {
    const geo = new GeometryEvaluator(wasm);
    run('difference() { cube(10); sphere(4); } translate([20,0,0]) cube(3);', geo);
    const { scene } = run('difference() { cube(10); sphere(4); } translate([20,0,0]) cube(4);', geo);
    expect(scene.stats.cacheHits).toBeGreaterThan(0);
  });
  it('non-manifold polyhedron falls back to soup', () => {
    const { scene, warnings } = run('polyhedron(points=[[0,0,0],[1,0,0],[0,1,0]], faces=[[0,1,2]]);');
    expect(warnings.length).toBe(1);
    expect(scene.meshes[0].triMaterials.length).toBe(1);
  });
});
