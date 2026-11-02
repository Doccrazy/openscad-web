import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { OpenSCADEngine } from '../src/engine';
import { EXAMPLES } from '../demo/examples';

describe('examples', async () => {
  const wasm = await Module();
  wasm.setup();
  const font = readFileSync('node_modules/@fontsource/arimo/files/arimo-latin-400-normal.woff');
  const engine = new OpenSCADEngine({
    wasm,
    fonts: [{ family: 'Liberation Sans', source: font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength) }],
  });
  for (const ex of EXAMPLES) {
    it(ex.name, async () => {
      const r = await engine.render(ex.code);
      const problems = r.messages.filter((m) => m.level !== 'echo');
      console.log(`${ex.name}: ${r.scene.stats.triangles} tris, eval ${r.timings.evalMs.toFixed(1)}ms, geom ${r.timings.geometryMs.toFixed(1)}ms`, problems.map((m) => `${m.line}: ${m.text}`));
      expect(problems).toEqual([]);
      expect(r.scene.meshes.length).toBeGreaterThan(0);
    });
  }
});
