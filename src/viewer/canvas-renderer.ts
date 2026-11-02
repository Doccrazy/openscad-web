import type { FrameParams } from './webgl-renderer';
import type { PreparedMesh } from './prepare';
import { transform4 } from './math';

/**
 * Software fallback renderer using Canvas 2D (painter's algorithm).
 * Used when WebGL2 is unavailable; adequate for small to medium models.
 */
export class Canvas2DRenderer {
  private ctx: CanvasRenderingContext2D;
  private meshes: PreparedMesh[] = [];
  /** Triangles drawn per frame at most (larger scenes are decimated while interacting). */
  maxTriangles = 150_000;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  setMeshes(meshes: PreparedMesh[]): void {
    this.meshes = meshes;
  }

  render(p: FrameParams): void {
    const { ctx } = this;
    const w = p.width, h = p.height;
    const bg = p.theme.background, bg2 = p.theme.backgroundBottom ?? bg;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const css = (c: number[], a = c[3]): string =>
      `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
    grad.addColorStop(0, css(bg, 1));
    grad.addColorStop(1, css(bg2, 1));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const vp = p.viewProj;
    const project = (x: number, y: number, z: number): [number, number, number] | null => {
      const [cx, cy, cz, cw] = transform4(vp, x, y, z);
      if (cw <= 1e-9) return null;
      return [((cx / cw) * 0.5 + 0.5) * w, (1 - ((cy / cw) * 0.5 + 0.5)) * h, cz / cw];
    };

    if (p.showGrid) {
      ctx.lineWidth = 1;
      const { step, extent } = p.grid;
      const n = Math.round(extent / step);
      for (let i = -n; i <= n; i++) {
        const v = i * step;
        ctx.strokeStyle = css(i % 10 === 0 ? p.theme.gridMajor : p.theme.grid);
        for (const [a, b] of [[[v, -extent], [v, extent]], [[-extent, v], [extent, v]]]) {
          const pa = project(a[0], a[1], 0), pb = project(b[0], b[1], 0);
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
          ctx.stroke();
        }
      }
    }

    // collect triangles
    let total = 0;
    for (const m of this.meshes) total += m.opaqueTriangles + m.transparentTriangles;
    const stride = Math.max(1, Math.ceil(total / this.maxTriangles));
    const tris: { opaque: boolean; d: number; pts: number[]; color: string }[] = [];
    const view = p.view;
    for (const m of this.meshes) {
      const n = m.opaqueTriangles + m.transparentTriangles;
      for (let t = 0; t < n; t += stride) {
        const o = t * 9;
        const P = m.positions;
        const a = project(P[o], P[o + 1], P[o + 2]);
        const b = project(P[o + 3], P[o + 4], P[o + 5]);
        const c = project(P[o + 6], P[o + 7], P[o + 8]);
        if (!a || !b || !c) continue;
        // view-space normal for shading
        const va = transform4(view, P[o], P[o + 1], P[o + 2]);
        const vb = transform4(view, P[o + 3], P[o + 4], P[o + 5]);
        const vc = transform4(view, P[o + 6], P[o + 7], P[o + 8]);
        const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
        const wx = vc[0] - va[0], wy = vc[1] - va[1], wz = vc[2] - va[2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const diff = 0.6 * Math.max(0, nx * 0.27 + ny * 0.45 + nz * 0.85) + 0.3 + 0.1 * nz;
        const C = m.colors;
        const ci = t * 12;
        const alpha = C[ci + 3] / 255;
        const r = Math.min(255, C[ci] * diff), g = Math.min(255, C[ci + 1] * diff), bb = Math.min(255, C[ci + 2] * diff);
        tris.push({
          opaque: alpha >= 1,
          d: (a[2] + b[2] + c[2]) / 3,
          pts: [a[0], a[1], b[0], b[1], c[0], c[1]],
          color: `rgba(${r | 0},${g | 0},${bb | 0},${alpha})`,
        });
      }
    }
    tris.sort((x, y) => y.d - x.d);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.6;
    for (const t of tris) {
      ctx.beginPath();
      ctx.moveTo(t.pts[0], t.pts[1]);
      ctx.lineTo(t.pts[2], t.pts[3]);
      ctx.lineTo(t.pts[4], t.pts[5]);
      ctx.closePath();
      ctx.fillStyle = t.color;
      ctx.fill();
      if (t.opaque) {
        // stroke with the same color hides seams between triangles
        ctx.strokeStyle = t.color;
        ctx.stroke();
      }
    }
  }

  dispose(): void {
    this.meshes = [];
  }
}
