import type { MeshData, SceneData } from '../geometry/types';
import type { RGBA, ViewerTheme } from './theme';

/** A mesh with resolved colors, triangles sorted so that opaque ones come first. */
export interface PreparedMesh {
  positions: Float32Array;
  /** RGBA8 per vertex. */
  colors: Uint8Array;
  opaqueTriangles: number;
  transparentTriangles: number;
  edges?: Float32Array;
  dim: 2 | 3;
  role: MeshData['role'];
}

function materialColor(m: MeshData, idx: number, theme: ViewerTheme): RGBA {
  if (m.role === 'highlight') return theme.highlight;
  if (m.role === 'background') return theme.backgroundModifier;
  const mat = m.materials[idx];
  if (!mat) return theme.model;
  if (mat.kind === 'color') return mat.color as RGBA;
  return mat.kind === 'cut' ? theme.cut : theme.model;
}

export function prepareMesh(m: MeshData, theme: ViewerTheme): PreparedMesh {
  const nTri = m.triMaterials.length;
  const colorsPerMat = new Map<number, RGBA>();
  const isOpaque = (i: number): boolean => {
    let c = colorsPerMat.get(i);
    if (!c) {
      c = materialColor(m, i, theme);
      colorsPerMat.set(i, c);
    }
    return c[3] >= 0.999;
  };
  let nOpaque = 0;
  for (let t = 0; t < nTri; t++) if (isOpaque(m.triMaterials[t])) nOpaque++;
  const positions = new Float32Array(nTri * 9);
  const colors = new Uint8Array(nTri * 12);
  let oi = 0, ti = nOpaque;
  for (let t = 0; t < nTri; t++) {
    const mi = m.triMaterials[t];
    const c = colorsPerMat.get(mi)!;
    const dst = c[3] >= 0.999 ? oi++ : ti++;
    positions.set(m.positions.subarray(t * 9, t * 9 + 9), dst * 9);
    const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255), a = Math.round(c[3] * 255);
    for (let k = 0; k < 3; k++) {
      const o = dst * 12 + k * 4;
      colors[o] = r; colors[o + 1] = g; colors[o + 2] = b; colors[o + 3] = a;
    }
  }
  return {
    positions,
    colors,
    opaqueTriangles: nOpaque,
    transparentTriangles: nTri - nOpaque,
    edges: m.role === 'model' ? m.edges : undefined,
    dim: m.dim,
    role: m.role,
  };
}

export function prepareScene(scene: SceneData, theme: ViewerTheme): PreparedMesh[] {
  return scene.meshes.map((m) => prepareMesh(m, theme));
}

/** Choose grid spacing for a scene. */
export function gridParams(scene: SceneData | null): { step: number; extent: number } {
  const b = scene?.bbox;
  let size = 100;
  if (b) size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[1]), Math.abs(b.max[1]), 1e-3);
  const step = Math.pow(10, Math.floor(Math.log10(size)) - 1);
  const major = step * 10;
  const extent = Math.ceil((size * 1.5) / major) * major;
  return { step, extent };
}
