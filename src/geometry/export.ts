import type { SceneData } from './types';

/** Export the model (not overlays) of a scene as binary STL. 2D parts are skipped. */
export function exportBinarySTL(scene: SceneData): ArrayBuffer {
  const meshes = scene.meshes.filter((m) => m.role === 'model' && m.dim === 3);
  let n = 0;
  for (const m of meshes) n += m.positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const header = 'openscad-web binary STL';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, n, true);
  let off = 84;
  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      view.setFloat32(off, nx, true);
      view.setFloat32(off + 4, ny, true);
      view.setFloat32(off + 8, nz, true);
      for (let k = 0; k < 9; k++) view.setFloat32(off + 12 + k * 4, p[i + k], true);
      view.setUint16(off + 48, 0, true);
      off += 50;
    }
  }
  return buf;
}
