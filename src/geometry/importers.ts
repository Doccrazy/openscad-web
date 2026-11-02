/** File importers producing indexed triangle meshes. Pure TypeScript, no WASM. */

export interface IndexedMesh {
  positions: number[];
  indices: number[];
}

const decoder = new TextDecoder();

function toText(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : decoder.decode(data);
}

/** Weld identical vertices so the mesh can become a manifold. */
function weld(raw: number[]): IndexedMesh {
  const map = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const key = `${raw[i]},${raw[i + 1]},${raw[i + 2]}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(raw[i], raw[i + 1], raw[i + 2]);
      map.set(key, idx);
    }
    indices.push(idx);
  }
  // drop degenerate triangles
  const clean: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a !== b && b !== c && a !== c) clean.push(a, b, c);
  }
  return { positions, indices: clean };
}

export function parseSTL(data: Uint8Array | string): IndexedMesh {
  if (typeof data !== 'string' && data.length >= 84) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = view.getUint32(80, true);
    if (84 + n * 50 === data.length) {
      const raw: number[] = [];
      for (let t = 0; t < n; t++) {
        const off = 84 + t * 50 + 12;
        for (let v = 0; v < 9; v++) raw.push(view.getFloat32(off + v * 4, true));
      }
      return weld(raw);
    }
  }
  const text = toText(data);
  const raw: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) raw.push(Number(m[1]), Number(m[2]), Number(m[3]));
  raw.length -= raw.length % 9;
  return weld(raw);
}

/** Triangulate a polygon face by fan (faces of imported files are assumed convex). */
function fan(face: number[], out: number[]): void {
  for (let i = 1; i + 1 < face.length; i++) out.push(face[0], face[i], face[i + 1]);
}

export function parseOFF(data: Uint8Array | string): IndexedMesh {
  const tokens = toText(data)
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l.length)
    .join(' ')
    .split(/\s+/);
  let i = 0;
  const header = tokens[i];
  if (/OFF$/i.test(header)) i++;
  else if (/OFF/i.test(header)) i++;
  const nv = Number(tokens[i++]);
  const nf = Number(tokens[i++]);
  i++; // edges
  const positions: number[] = [];
  for (let v = 0; v < nv; v++) {
    positions.push(Number(tokens[i]), Number(tokens[i + 1]), Number(tokens[i + 2]));
    i += 3;
    if (/^C/.test(header)) i += 4; // per-vertex colors (approximate)
  }
  const indices: number[] = [];
  for (let f = 0; f < nf; f++) {
    const k = Number(tokens[i++]);
    const face: number[] = [];
    for (let j = 0; j < k; j++) face.push(Number(tokens[i++]));
    fan(face, indices);
    // skip optional color values up to next face: they are not distinguishable in the flat
    // token stream, so OFF files with face colors are only supported if one color per line
  }
  return { positions, indices };
}

export function parseOBJ(data: Uint8Array | string): IndexedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const line of toText(data).split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') positions.push(Number(p[1]), Number(p[2]), Number(p[3]));
    else if (p[0] === 'f') {
      const nv = positions.length / 3;
      const face = p.slice(1).map((s) => {
        const idx = parseInt(s.split('/')[0], 10);
        return idx < 0 ? nv + idx : idx - 1;
      });
      fan(face, indices);
    }
  }
  return { positions, indices };
}

/**
 * Parse an OpenSCAD surface() .dat height map into a closed mesh.
 * Rows are y, columns are x; the mesh is closed with a floor below the minimum.
 */
export function parseHeightmap(data: Uint8Array | string, center: boolean, invert: boolean): IndexedMesh | undefined {
  const rows: number[][] = [];
  for (const line of toText(data).split('\n')) {
    const l = line.replace(/#.*/, '').trim();
    if (!l) continue;
    rows.push(l.split(/[\s,]+/).map(Number));
  }
  if (!rows.length) return undefined;
  const nx = Math.min(...rows.map((r) => r.length));
  const ny = rows.length;
  if (nx < 2 || ny < 2) return undefined;
  rows.reverse(); // first line is the top row (largest y)
  let min = Infinity;
  for (const r of rows) for (let x = 0; x < nx; x++) {
    if (invert) r[x] = -r[x];
    min = Math.min(min, r[x]);
  }
  const floor = min - 1;
  const ox = center ? -(nx - 1) / 2 : 0;
  const oy = center ? -(ny - 1) / 2 : 0;
  const positions: number[] = [];
  const indices: number[] = [];
  const top = (x: number, y: number): number => y * nx + x;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) positions.push(x + ox, y + oy, rows[y][x]);
  const base = positions.length / 3;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) positions.push(x + ox, y + oy, floor);
  const bot = (x: number, y: number): number => base + y * nx + x;
  for (let y = 0; y + 1 < ny; y++) {
    for (let x = 0; x + 1 < nx; x++) {
      indices.push(top(x, y), top(x + 1, y), top(x + 1, y + 1), top(x, y), top(x + 1, y + 1), top(x, y + 1));
      indices.push(bot(x, y), bot(x + 1, y + 1), bot(x + 1, y), bot(x, y), bot(x, y + 1), bot(x + 1, y + 1));
    }
  }
  // side walls; p0 -> p1 runs left to right when viewed from outside
  const wall = (t0: number, t1: number, b0: number, b1: number): void => {
    indices.push(b0, b1, t1, b0, t1, t0);
  };
  for (let x = 0; x + 1 < nx; x++) {
    wall(top(x, 0), top(x + 1, 0), bot(x, 0), bot(x + 1, 0));
    wall(top(x + 1, ny - 1), top(x, ny - 1), bot(x + 1, ny - 1), bot(x, ny - 1));
  }
  for (let y = 0; y + 1 < ny; y++) {
    wall(top(0, y + 1), top(0, y), bot(0, y + 1), bot(0, y));
    wall(top(nx - 1, y), top(nx - 1, y + 1), bot(nx - 1, y), bot(nx - 1, y + 1));
  }
  return { positions, indices };
}

/** Cheap content hash (FNV-1a 32 bit) for cache keys. */
export function hashBytes(data: Uint8Array | string): string {
  let h = 0x811c9dc5;
  if (typeof data === 'string') {
    for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 0x01000193);
  } else {
    for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + data.length;
}
