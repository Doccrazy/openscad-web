import type { Color } from '../eval/csg-tree';

/**
 * Material of a triangle. `default` and `cut` are resolved by the viewer's
 * theme (cut = surfaces created by subtracting an uncolored object).
 */
export type Material = { kind: 'default' } | { kind: 'cut' } | { kind: 'color'; color: Color };

export type MeshRole = 'model' | 'highlight' | 'background';

/**
 * A renderable triangle mesh. Triangles are non-indexed (3 vertices each) so
 * that every triangle can carry its own material and flat normal.
 */
export interface MeshData {
  /** xyz per vertex; length = triangles * 9 */
  positions: Float32Array;
  /** Index into `materials` per triangle. */
  triMaterials: Uint16Array;
  materials: Material[];
  role: MeshRole;
  /** 2D geometry is rendered flat at z = 0 and double-sided. */
  dim: 2 | 3;
  /** Feature edges (pairs of xyz points), optional. */
  edges?: Float32Array;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SceneData {
  meshes: MeshData[];
  bbox: BoundingBox | null;
  stats: {
    triangles: number;
    /** Time spent in geometry evaluation (ms). */
    geometryMs: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

export function sceneBBox(meshes: MeshData[]): BoundingBox | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
}
