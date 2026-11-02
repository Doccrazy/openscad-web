import type { BoundingBox } from '../geometry/types';
import { M4, V3, lookAt, mul, ortho, perspective } from './math';

export type Projection = 'perspective' | 'orthographic';
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

const DEG = Math.PI / 180;

/** Turntable camera orbiting a target point, Z up (OpenSCAD convention). */
export class OrbitCamera {
  target: V3 = [0, 0, 0];
  /** Rotation around Z in degrees (0 = looking along +Y). */
  azimuth = 25;
  /** Elevation above the XY plane in degrees. */
  elevation = 35;
  distance = 140;
  fovy = 22.5;
  projection: Projection = 'perspective';

  eye(): V3 {
    const ce = Math.cos(this.elevation * DEG), se = Math.sin(this.elevation * DEG);
    const sa = Math.sin(this.azimuth * DEG), ca = Math.cos(this.azimuth * DEG);
    return [this.target[0] + this.distance * ce * sa, this.target[1] - this.distance * ce * ca, this.target[2] + this.distance * se];
  }

  /** Camera basis vectors in world space: right, up, forward. */
  basis(): { right: V3; up: V3; forward: V3 } {
    const e = this.eye();
    const f: V3 = [this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]];
    const fl = Math.hypot(...f) || 1;
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    const worldUp: V3 = Math.abs(this.elevation) > 89.9 ? [-Math.sin(this.azimuth * DEG), Math.cos(this.azimuth * DEG), 0] : [0, 0, 1];
    let r: V3 = [f[1] * worldUp[2] - f[2] * worldUp[1], f[2] * worldUp[0] - f[0] * worldUp[2], f[0] * worldUp[1] - f[1] * worldUp[0]];
    const rl = Math.hypot(...r) || 1;
    r = [r[0] / rl, r[1] / rl, r[2] / rl];
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { right: r, up: u, forward: f };
  }

  view(): M4 {
    return lookAt(this.eye(), this.target, this.basis().up);
  }

  proj(aspect: number, sceneRadius: number): M4 {
    // sceneRadius: radius around the origin enclosing everything drawn (model, grid, axes)
    const t = Math.hypot(...this.target);
    const far = this.distance + t + sceneRadius * 2 + 1;
    const near = Math.max(this.distance * 0.005, this.distance - t - sceneRadius * 2, far * 1e-5);
    if (this.projection === 'orthographic') {
      const h = this.distance * Math.tan((this.fovy * DEG) / 2);
      return ortho(-h * aspect, h * aspect, -h, h, -far, far);
    }
    return perspective(this.fovy * DEG, aspect, Math.max(near, 0.01), far);
  }

  viewProj(aspect: number, sceneRadius: number): M4 {
    return mul(this.proj(aspect, sceneRadius), this.view());
  }

  orbit(dAz: number, dEl: number): void {
    this.azimuth = (this.azimuth + dAz) % 360;
    this.elevation = Math.max(-90, Math.min(90, this.elevation + dEl));
  }

  /** Pan by a screen-space delta expressed as a fraction of the viewport height. */
  pan(dx: number, dy: number): void {
    const { right, up } = this.basis();
    const h = 2 * this.distance * Math.tan((this.fovy * DEG) / 2);
    for (let i = 0; i < 3; i++) this.target[i] += (-dx * right[i] + dy * up[i]) * h;
  }

  zoom(factor: number): void {
    this.distance = Math.max(1e-3, Math.min(1e7, this.distance * factor));
  }

  fit(bbox: BoundingBox | null, aspect = 1): void {
    if (!bbox) {
      this.target = [0, 0, 0];
      this.distance = 140;
      return;
    }
    const c: V3 = [0, 1, 2].map((i) => (bbox.min[i] + bbox.max[i]) / 2) as V3;
    const r = Math.max(1e-3, Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) / 2);
    this.target = c;
    const fov = this.fovy * DEG;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
    this.distance = (r / Math.sin(fit / 2)) * 0.95;
  }

  setView(preset: ViewPreset): void {
    const presets: Record<ViewPreset, [number, number]> = {
      iso: [25, 35],
      top: [0, 90],
      bottom: [0, -90],
      front: [0, 0],
      back: [180, 0],
      left: [-90, 0],
      right: [90, 0],
    };
    [this.azimuth, this.elevation] = presets[preset];
  }
}
