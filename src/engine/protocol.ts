import type { FontSource } from './fonts';
import type { RenderOptions, RenderResult } from './engine';

export type ToWorker =
  | { type: 'init'; wasmUrl?: string; fonts?: FontSource[]; edges?: boolean }
  | { type: 'render'; id: number; source: string; options: RenderOptions }
  | { type: 'resolved'; reqId: number; result: { path: string; data: string | Uint8Array } | null }
  | { type: 'invalidate'; paths?: string[] };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: RenderResult }
  | { type: 'error'; id: number; message: string }
  | { type: 'resolve'; reqId: number; path: string; relativeTo?: string; binary: boolean };

export function transferablesOf(result: RenderResult): Transferable[] {
  const out: Transferable[] = [];
  for (const m of result.scene.meshes) {
    out.push(m.positions.buffer, m.triMaterials.buffer);
    if (m.edges) out.push(m.edges.buffer);
  }
  return out;
}
