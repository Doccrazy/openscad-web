/** Minimal column-major 4x4 matrix utilities (same layout as WebGL / manifold). */

export type Mat4 = number[]; // length 16, column-major
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function isIdentity(m: Mat4): boolean {
  const id = identity();
  for (let i = 0; i < 16; i++) if (m[i] !== id[i]) return false;
  return true;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** sin in degrees with exact results for multiples of 30/90 degrees. */
export function sind(deg: number): number {
  if (!Number.isFinite(deg)) return NaN;
  let d = deg % 360;
  if (d < 0) d += 360;
  if (d === 0 || d === 180) return 0;
  if (d === 90) return 1;
  if (d === 270) return -1;
  if (d === 30 || d === 150) return 0.5;
  if (d === 210 || d === 330) return -0.5;
  return Math.sin((d * Math.PI) / 180);
}

export function cosd(deg: number): number {
  return sind(deg + 90);
}

export function rotationX(deg: number): Mat4 {
  const c = cosd(deg), s = sind(deg);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export function rotationY(deg: number): Mat4 {
  const c = cosd(deg), s = sind(deg);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

export function rotationZ(deg: number): Mat4 {
  const c = cosd(deg), s = sind(deg);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation about arbitrary axis (degrees). */
export function rotationAxis(deg: number, axis: Vec3): Mat4 {
  let [x, y, z] = axis;
  const len = Math.hypot(x, y, z);
  if (len === 0) return identity();
  x /= len; y /= len; z /= len;
  const c = cosd(deg), s = sind(deg), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

export function mirror(n: Vec3): Mat4 {
  const [x, y, z] = n;
  const l2 = x * x + y * y + z * z;
  if (l2 === 0) return identity();
  const a = (2 * x) / l2, b = (2 * y) / l2, c = (2 * z) / l2;
  return [1 - a * x, -b * x, -c * x, 0, -a * y, 1 - b * y, -c * y, 0, -a * z, -b * z, 1 - c * z, 0, 0, 0, 0, 1];
}

export function transformPoint(m: Mat4, p: ArrayLike<number>): Vec3 {
  const x = p[0], y = p[1], z = p[2] ?? 0;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function determinant3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** Is this transform purely within the XY plane (keeps z=0 plane at z=0)? */
export function isPlanar(m: Mat4): boolean {
  const e = 1e-12;
  return (
    Math.abs(m[2]) < e && Math.abs(m[6]) < e && Math.abs(m[8]) < e && Math.abs(m[9]) < e &&
    Math.abs(m[14]) < e && Math.abs(m[3]) < e && Math.abs(m[7]) < e && Math.abs(m[11]) < e
  );
}
