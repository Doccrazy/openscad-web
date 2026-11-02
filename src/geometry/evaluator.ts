import type { CrossSection, Manifold, ManifoldToplevel, Mat4 as MMat4, Vec2 as MVec2 } from 'manifold-3d';
import type { Color, GeomNode, Vec2, Vec3 } from '../eval/csg-tree';
import { fragmentsForRadius, hasChildren } from '../eval/csg-tree';
import * as M from '../math/mat4';
import { FontProvider, textToContours } from './text';
import { Material, MeshData, MeshRole, SceneData, sceneBBox } from './types';

/** A triangle soup that could not be turned into a manifold (rendered, but not CSG'ed). */
interface Soup {
  positions: Float32Array;
  indices: Uint32Array;
  colorId: number;
}

/**
 * Evaluated geometry of a node. 2D and 3D parts are tracked separately.
 * 3D geometry is a list of possibly overlapping solids ("lazy union"): unions
 * are only computed when an operation needs a single solid.
 */
interface Geo {
  parts: Manifold[];
  /** Memoized union of `parts`. */
  merged?: Manifold;
  cs?: CrossSection;
  csColor?: Color;
  soups: Soup[];
}

const EMPTY: Geo = Object.freeze({ parts: Object.freeze([]) as unknown as Manifold[], soups: Object.freeze([]) as unknown as Soup[] }) as Geo;

const has3D = (g: Geo): boolean => g.parts.length > 0;

export interface GeometryWarning {
  text: string;
  src?: { file?: string; pos: number; end: number };
}

export interface EvaluateOptions {
  /**
   * Compute exact unions of all top-level objects (like OpenSCAD's F6 render).
   * When false (default, "preview"), overlapping objects that are only unioned
   * are displayed without computing the boolean, which is much faster.
   */
  exact?: boolean;
}

export interface GeometryOptions {
  fonts?: FontProvider;
  /** Compute feature edges for outline rendering (default true). */
  edges?: boolean;
  /** Angle threshold in degrees for feature edges (default 25). */
  edgeAngle?: number;
}

type Deletable = { delete(): void };

/** Fast 53-bit string hash. */
function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/**
 * Converts a CSG tree into renderable meshes using the manifold library.
 * Results are cached per subtree, so re-evaluating a slightly changed model
 * only recomputes the changed branches.
 */
export class GeometryEvaluator {
  private cache = new Map<string, Geo>();
  private usedKeys = new Set<string>();
  private nodeKeys = new WeakMap<GeomNode, string>();
  /** All live WASM objects owned by this evaluator. */
  private live = new Set<Deletable>();
  /** originalID -> color (undefined = default color). */
  private idColors = new Map<number, Color | undefined>();
  private soupColors: (Color | undefined)[] = [];
  private warnings: GeometryWarning[] = [];
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly wasm: ManifoldToplevel,
    private readonly options: GeometryOptions = {},
  ) {}

  /** Release all cached WASM memory. */
  dispose(): void {
    for (const o of this.live) o.delete();
    this.live.clear();
    this.cache.clear();
  }

  evaluate(nodes: GeomNode[], opts: EvaluateOptions = {}): { scene: SceneData; warnings: GeometryWarning[] } {
    const t0 = performance.now();
    this.usedKeys = new Set();
    this.warnings = [];
    this.hits = this.misses = 0;
    const meshes: MeshData[] = [];
    try {
      const root = this.union(nodes.map((n) => this.eval(n, undefined)));
      meshes.push(...this.toMeshes(root, 'model', !!opts.exact));

      // overlays (# and %) with their accumulated transforms
      const overlays: { node: GeomNode; matrix: M.Mat4; color?: Color; mode: 'highlight' | 'background' }[] = [];
      const collect = (n: GeomNode, mat: M.Mat4, color: Color | undefined): void => {
        switch (n.type) {
          case 'transform':
            for (const c of n.children) collect(c, M.multiply(mat, n.matrix), color);
            return;
          case 'color':
            for (const c of n.children) collect(c, mat, n.color);
            return;
          case 'modifier':
            overlays.push({ node: { type: 'group', children: n.children }, matrix: mat, color, mode: n.mode });
            for (const c of n.children) collect(c, mat, color);
            return;
          case 'group': case 'union': case 'difference': case 'intersection':
          case 'hull': case 'minkowski': case 'render':
            for (const c of n.children) collect(c, mat, color);
            return;
        }
      };
      for (const n of nodes) collect(n, M.identity(), undefined);
      for (const o of overlays) {
        let g = this.eval(o.node, o.color, true);
        if (!M.isIdentity(o.matrix)) g = this.transform(g, o.matrix);
        meshes.push(...this.toMeshes(g, o.mode, false));
      }
    } finally {
      this.collectGarbage();
    }
    const geometryMs = performance.now() - t0;
    let triangles = 0;
    for (const m of meshes) if (m.role === 'model') triangles += m.triMaterials.length;
    return {
      scene: {
        meshes,
        bbox: sceneBBox(meshes),
        stats: { triangles, geometryMs, cacheHits: this.hits, cacheMisses: this.misses },
      },
      warnings: this.warnings,
    };
  }

  // -- memory management ---------------------------------------------------------------

  private track<T extends Deletable>(o: T): T {
    this.live.add(o);
    return o;
  }

  private collectGarbage(): void {
    // drop cache entries not used in this run
    for (const k of [...this.cache.keys()]) if (!this.usedKeys.has(k)) this.cache.delete(k);
    const keep = new Set<Deletable>();
    for (const g of this.cache.values()) {
      for (const m of g.parts) keep.add(m);
      if (g.merged) keep.add(g.merged);
      if (g.cs) keep.add(g.cs);
    }
    for (const o of this.live) {
      if (!keep.has(o)) {
        o.delete();
        this.live.delete(o);
      }
    }
  }

  // -- keys ----------------------------------------------------------------------------

  private keyOf(n: GeomNode): string {
    let k = this.nodeKeys.get(n);
    if (k) return k;
    let own: string;
    if (n.type === 'mesh') own = 'mesh:' + n.key;
    else {
      const rest: Record<string, unknown> = {};
      for (const [p, v] of Object.entries(n)) if (p !== 'children' && p !== 'src') rest[p] = v;
      own = JSON.stringify(rest);
    }
    const children = hasChildren(n) ? n.children.map((c) => this.keyOf(c)).join(',') : '';
    k = hashString(own + '|' + children);
    this.nodeKeys.set(n, k);
    return k;
  }

  private warn(text: string, n?: GeomNode): void {
    this.warnings.push({ text, src: n?.src });
  }

  // -- evaluation ----------------------------------------------------------------------

  /**
   * Evaluate a node. `color` is the innermost enclosing color (OpenSCAD semantics).
   * `includeBackground` is set when evaluating an overlay subtree.
   */
  private eval(n: GeomNode, color: Color | undefined, includeBackground = false): Geo {
    const key = this.keyOf(n) + (color ? '@' + color.join(',') : '') + (includeBackground ? '+bg' : '');
    const cached = this.cache.get(key);
    this.usedKeys.add(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    let g: Geo;
    try {
      g = this.compute(n, color, includeBackground);
    } catch (e) {
      this.warn(`${n.type}: ${(e as Error).message ?? e}`, n);
      g = EMPTY;
    }
    this.cache.set(key, g);
    return g;
  }

  private evalChildren(n: Extract<GeomNode, { children: GeomNode[] }>, color: Color | undefined, bg: boolean): Geo[] {
    return n.children.map((c) => this.eval(c, color, bg));
  }

  private newOriginal(m: Manifold, color: Color | undefined): Manifold {
    const o = this.track(m.asOriginal());
    this.idColors.set(o.originalID(), color);
    return o;
  }

  private soupColorId(color: Color | undefined): number {
    this.soupColors.push(color);
    return this.soupColors.length - 1;
  }

  private compute(n: GeomNode, color: Color | undefined, bg: boolean): Geo {
    const { Manifold, CrossSection } = this.wasm;
    switch (n.type) {
      case 'cube': {
        const m = this.track(Manifold.cube(n.size, n.center));
        return this.solid(this.newOriginal(m, color));
      }
      case 'sphere':
        return this.fromMesh(sphereMesh(n.r, n.segments), color, n);
      case 'cylinder':
        return this.fromMesh(cylinderMesh(n.h, n.r1, n.r2, n.segments, n.center), color, n);
      case 'polyhedron':
        return this.fromMesh(this.polyhedronMesh(n.points, n.faces), color, n);
      case 'mesh':
        return this.fromMesh({ positions: n.positions, indices: n.indices }, color, n);
      case 'square': {
        const [w, h] = n.size;
        const pts: MVec2[] = [[0, 0], [w, 0], [w, h], [0, h]];
        const o = n.center ? [w / 2, h / 2] : [0, 0];
        return this.cs2(new CrossSection(pts.map(([x, y]) => [x - o[0], y - o[1]] as MVec2)), color);
      }
      case 'circle':
        return this.cs2(new CrossSection(circlePoints(n.r, n.segments)), color);
      case 'polygon': {
        const contours: MVec2[][] = n.paths
          ? n.paths.map((p) => p.map((i) => n.points[i] as MVec2))
          : [n.points as MVec2[]];
        return this.cs2(new CrossSection(contours.filter((c) => c.length >= 3), 'EvenOdd'), color);
      }
      case 'text': {
        const font = this.options.fonts?.getFont(n.font);
        if (!font) {
          this.warn('text(): no font available', n);
          return EMPTY;
        }
        const contours = textToContours(n, font);
        if (!contours.length) return EMPTY;
        return this.cs2(new CrossSection(contours as MVec2[][], 'NonZero'), color);
      }
      case 'transform':
        return this.transform(this.union(this.evalChildren(n, color, bg)), n.matrix);
      case 'color':
        return this.union(n.children.map((c) => this.eval(c, n.color, bg)));
      case 'modifier':
        if (n.mode === 'background' && !bg) return EMPTY;
        return this.union(this.evalChildren(n, color, bg));
      case 'group':
      case 'union':
      case 'render':
        return this.union(this.evalChildren(n, color, bg));
      case 'difference':
        return this.difference(this.evalChildren(n, color, bg));
      case 'intersection':
        return this.intersection(this.evalChildren(n, color, bg));
      case 'hull':
        return this.hull(this.evalChildren(n, color, bg), color);
      case 'minkowski':
        return this.minkowski(this.evalChildren(n, color, bg), color, n);
      case 'linear_extrude': {
        const g = this.union(this.evalChildren(n, color, bg));
        if (!g.cs) {
          if (has3D(g)) this.warn('linear_extrude() requires 2D children', n);
          return EMPTY;
        }
        let slices = n.slices;
        if (slices === undefined) {
          if (n.twist !== 0) {
            const r = maxRadius(g.cs);
            slices = Math.max(1, Math.floor((fragmentsForRadius(r, n.frag) * Math.abs(n.twist)) / 360));
          } else slices = 1;
        }
        const m = this.track(
          g.cs.extrude(n.height, slices - 1, -n.twist, n.scale as MVec2, n.center),
        );
        return this.solid(this.newOriginal(m, color ?? g.csColor));
      }
      case 'rotate_extrude': {
        const g = this.union(this.evalChildren(n, color, bg));
        if (!g.cs) {
          if (has3D(g)) this.warn('rotate_extrude() requires 2D children', n);
          return EMPTY;
        }
        const b = g.cs.bounds();
        if (b.min[0] < -1e-9 && b.max[0] > 1e-9) {
          this.warn('rotate_extrude(): all points must have the same X coordinate sign', n);
        }
        let cs = g.cs;
        if (b.max[0] <= 1e-9) cs = this.track(cs.mirror([1, 0]));
        const r = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
        const segs = fragmentsForRadius(r, n.frag);
        let m = this.track(cs.revolve(segs, Math.abs(n.angle)));
        if (n.angle < 0) m = this.track(m.mirror([0, 1, 0]));
        return this.solid(this.newOriginal(m, color ?? g.csColor));
      }
      case 'offset': {
        const g = this.union(this.evalChildren(n, color, bg));
        if (!g.cs) return EMPTY;
        let cs: CrossSection;
        if (n.r !== undefined) {
          cs = g.cs.offset(n.r, 'Round', 2, fragmentsForRadius(Math.abs(n.r), n.frag));
        } else {
          cs = g.cs.offset(n.delta ?? 1, n.chamfer ? 'Square' : 'Miter', 1e6);
        }
        return { parts: [], cs: this.track(cs), csColor: g.csColor, soups: [] };
      }
      case 'projection': {
        const g = this.union(this.evalChildren(n, color, bg));
        if (!has3D(g)) return EMPTY;
        // project / slice every part and union in 2D (no 3D boolean needed)
        const pieces = g.parts.map((m) => this.track(n.cut ? m.slice(0) : m.project()));
        const cs = pieces.length === 1 ? pieces[0] : this.track(CrossSection.union(pieces));
        return { parts: [], cs, csColor: color, soups: [] };
      }
      case 'resize':
        return this.resize(this.union(this.evalChildren(n, color, bg)), n.size, n.auto);
    }
  }

  private cs2(cs: CrossSection, color: Color | undefined): Geo {
    return { parts: [], cs: this.track(cs), csColor: color, soups: [] };
  }

  private solid(m: Manifold): Geo {
    return { parts: [m], soups: [] };
  }

  /** Union of all 3D parts (memoized). */
  private materialize(g: Geo): Manifold | undefined {
    if (g.parts.length === 0) return undefined;
    if (g.parts.length === 1) return g.parts[0];
    if (!g.merged) g.merged = this.track(this.wasm.Manifold.union(g.parts));
    return g.merged;
  }

  /** Create a manifold from an indexed mesh, falling back to a triangle soup. */
  private fromMesh(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }, color: Color | undefined, n: GeomNode): Geo {
    const { Manifold, Mesh } = this.wasm;
    const vertProperties = Float32Array.from(mesh.positions);
    const triVerts = Uint32Array.from(mesh.indices);
    // be forgiving: fix meshes whose faces are consistently inverted
    if (signedVolume(vertProperties, triVerts) < 0) {
      for (let i = 0; i < triVerts.length; i += 3) {
        const t = triVerts[i + 1];
        triVerts[i + 1] = triVerts[i + 2];
        triVerts[i + 2] = t;
      }
    }
    try {
      const mm = new Mesh({ numProp: 3, vertProperties, triVerts });
      mm.merge();
      const m = this.track(new Manifold(mm));
      if (m.isEmpty()) return EMPTY;
      return this.solid(this.newOriginal(m, color));
    } catch {
      this.warn(`${n.type}: mesh is not closed/manifold – it will be displayed but ignored in CSG operations`, n);
      return { parts: [], soups: [{ positions: vertProperties, indices: triVerts, colorId: this.soupColorId(color) }] };
    }
  }

  private polyhedronMesh(points: Vec3[], faces: number[][]): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    for (const p of points) positions.push(p[0], p[1], p[2]);
    const indices: number[] = [];
    for (const f0 of faces) {
      // remove consecutive duplicates
      const f = f0.filter((v, i) => v !== f0[(i + 1) % f0.length]);
      if (f.length < 3) continue;
      // OpenSCAD faces are clockwise seen from outside -> reverse for CCW
      if (f.length === 3) {
        indices.push(f[0], f[2], f[1]);
        continue;
      }
      // project onto the best-fit plane and triangulate
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < f.length; i++) {
        const a = points[f[i]], b = points[f[(i + 1) % f.length]];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      // drop the dominant axis; keep orientation so that the polygon is CCW after reversal
      const proj = (p: Vec3): MVec2 => (az >= ax && az >= ay ? [p[0], p[1]] : ax >= ay ? [p[1], p[2]] : [p[2], p[0]]);
      const sign = az >= ax && az >= ay ? nz : ax >= ay ? nx : ny;
      // face is CW from outside => its Newell normal points inward; reversed order is CCW
      const rev = [...f].reverse();
      let poly = rev.map((i) => proj(points[i]));
      // Newell normal of the original (CW) face points inward, so the reversed face's
      // projection is CCW iff sign < 0
      let order = rev;
      if (sign > 0) {
        order = [...rev].reverse();
        poly = order.map((i) => proj(points[i]));
      }
      let tris: [number, number, number][];
      try {
        tris = this.wasm.triangulate([poly], 1e-9) as [number, number, number][];
      } catch {
        tris = [];
        for (let i = 1; i + 1 < poly.length; i++) tris.push([0, i, i + 1]);
      }
      for (const [a, b, c] of tris) {
        if (sign > 0) indices.push(order[a], order[c], order[b]);
        else indices.push(order[a], order[b], order[c]);
      }
    }
    return { positions, indices };
  }

  // -- operations ---------------------------------------------------------------------

  private transform(g: Geo, mat: M.Mat4): Geo {
    if (g === EMPTY) return g;
    const out: Geo = { parts: g.parts.map((m) => this.track(m.transform(mat as unknown as MMat4))), soups: [] };
    if (g.cs) {
      out.cs = this.track(g.cs.transform([mat[0], mat[1], 0, mat[4], mat[5], 0, mat[12], mat[13], 1]));
      out.csColor = g.csColor;
    }
    for (const s of g.soups) {
      const p = new Float32Array(s.positions.length);
      for (let i = 0; i < p.length; i += 3) {
        const [x, y, z] = M.transformPoint(mat, [s.positions[i], s.positions[i + 1], s.positions[i + 2]]);
        p[i] = x; p[i + 1] = y; p[i + 2] = z;
      }
      let idx = s.indices;
      if (M.determinant3(mat) < 0) {
        idx = new Uint32Array(s.indices.length);
        for (let i = 0; i < idx.length; i += 3) {
          idx[i] = s.indices[i]; idx[i + 1] = s.indices[i + 2]; idx[i + 2] = s.indices[i + 1];
        }
      }
      out.soups.push({ positions: p, indices: idx, colorId: s.colorId });
    }
    return out;
  }

  private union(gs: Geo[]): Geo {
    const parts = gs.filter((g) => g !== EMPTY && (has3D(g) || g.cs || g.soups.length));
    if (parts.length === 0) return EMPTY;
    if (parts.length === 1) return parts[0];
    const { CrossSection } = this.wasm;
    const css = parts.filter((g) => g.cs);
    // lazy union: just collect the solids
    const out: Geo = { parts: parts.flatMap((g) => g.parts), soups: parts.flatMap((g) => g.soups) };
    if (css.length === 1) {
      out.cs = css[0].cs;
      out.csColor = css[0].csColor;
    } else if (css.length > 1) {
      out.cs = this.track(CrossSection.union(css.map((g) => g.cs!)));
      out.csColor = css[0].csColor;
    }
    return out;
  }

  private difference(gs: Geo[]): Geo {
    if (!gs.length) return EMPTY;
    const [first, ...rest] = gs;
    if (first === EMPTY) return EMPTY;
    const others = this.union(rest);
    if (others === EMPTY) return first;
    const out: Geo = { parts: [], soups: first.soups };
    const a = this.materialize(first);
    const b = this.materialize(others);
    if (a) out.parts = [b ? this.track(a.subtract(b)) : a];
    if (first.cs) {
      out.cs = others.cs ? this.track(first.cs.subtract(others.cs)) : first.cs;
      out.csColor = first.csColor;
    }
    return out;
  }

  private intersection(gs: Geo[]): Geo {
    const parts = gs.filter((g) => g !== EMPTY);
    if (parts.length !== gs.length || !parts.length) return EMPTY;
    if (parts.length === 1) return parts[0];
    const { Manifold, CrossSection } = this.wasm;
    const out: Geo = { parts: [], soups: [] };
    if (parts.every(has3D)) out.parts = [this.track(Manifold.intersection(parts.map((g) => this.materialize(g)!)))];
    if (parts.every((g) => g.cs)) {
      out.cs = this.track(CrossSection.intersection(parts.map((g) => g.cs!)));
      out.csColor = parts[0].csColor;
    }
    return out;
  }

  private hull(gs: Geo[], color: Color | undefined): Geo {
    const parts = gs.filter((g) => g !== EMPTY);
    if (!parts.length) return EMPTY;
    const { Manifold, CrossSection } = this.wasm;
    const ms = parts.filter((g) => has3D(g) || g.soups.length);
    if (ms.length) {
      const pts: [number, number, number][] = [];
      const items: (Manifold | [number, number, number])[] = [];
      for (const g of ms) {
        items.push(...g.parts);
        for (const s of g.soups)
          for (let i = 0; i < s.positions.length; i += 3) pts.push([s.positions[i], s.positions[i + 1], s.positions[i + 2]]);
      }
      const h = this.track(Manifold.hull([...items, ...pts]));
      return this.solid(this.newOriginal(h, color ?? this.firstColor(parts)));
    }
    const cs = this.track(CrossSection.hull(parts.filter((g) => g.cs).map((g) => g.cs!)));
    return { parts: [], cs, csColor: color ?? parts[0].csColor, soups: [] };
  }

  private firstColor(gs: Geo[]): Color | undefined {
    for (const g of gs) {
      if (has3D(g)) {
        const mesh = g.parts[0].getMesh();
        if (mesh.runOriginalID?.length) return this.idColors.get(mesh.runOriginalID[0]);
      }
    }
    return undefined;
  }

  private minkowski(gs: Geo[], color: Color | undefined, n: GeomNode): Geo {
    const parts = gs.filter((g) => g !== EMPTY);
    if (!parts.length) return EMPTY;
    if (parts.length === 1) return parts[0];
    const ms = parts.filter(has3D);
    if (ms.length) {
      let acc = this.materialize(ms[0])!;
      for (let i = 1; i < ms.length; i++) acc = this.track(acc.minkowskiSum(this.materialize(ms[i])!));
      return this.solid(this.newOriginal(acc, color ?? this.firstColor(parts)));
    }
    // 2D: decompose operands into convex parts and union the pairwise hull sums
    let acc = parts[0].cs;
    for (let i = 1; i < parts.length && acc; i++) {
      const b = parts[i].cs;
      if (b) acc = this.minkowski2D(acc, b);
    }
    if (!acc) this.warn('minkowski(): cannot combine 2D and 3D objects', n);
    return { parts: [], cs: acc, csColor: color ?? parts[0].csColor, soups: [] };
  }

  private minkowski2D(a: CrossSection, b: CrossSection): CrossSection {
    const { CrossSection } = this.wasm;
    const pieces: CrossSection[] = [];
    const convexParts = (cs: CrossSection): MVec2[][] => {
      const polys = cs.toPolygons() as MVec2[][];
      const flat = polys.flat();
      const tris = this.wasm.triangulate(polys) as [number, number, number][];
      return tris.map((t) => t.map((i) => flat[i]));
    };
    const aParts = isConvex(a) ? [(a.toPolygons() as MVec2[][]).flat()] : convexParts(a);
    const bParts = isConvex(b) ? [(b.toPolygons() as MVec2[][]).flat()] : convexParts(b);
    for (const pa of aParts) {
      for (const pb of bParts) {
        const sum: MVec2[] = [];
        for (const p of pa) for (const q of pb) sum.push([p[0] + q[0], p[1] + q[1]]);
        pieces.push(this.track(CrossSection.hull([sum])));
      }
    }
    return this.track(CrossSection.union(pieces));
  }

  private resize(g: Geo, size: Vec3, auto: [boolean, boolean, boolean]): Geo {
    if (g === EMPTY) return g;
    let lo: number[], hi: number[];
    if (has3D(g)) {
      lo = [Infinity, Infinity, Infinity];
      hi = [-Infinity, -Infinity, -Infinity];
      for (const m of g.parts) {
        const b = m.boundingBox();
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], b.min[i]);
          hi[i] = Math.max(hi[i], b.max[i]);
        }
      }
    } else if (g.cs) {
      const b = g.cs.bounds();
      lo = [b.min[0], b.min[1], 0];
      hi = [b.max[0], b.max[1], 0];
    } else return g;
    const dims = [0, 1, 2].map((i) => hi[i] - lo[i]);
    const scale = [1, 1, 1];
    let autoscale = 0;
    for (let i = 0; i < 3; i++) {
      if (size[i] > 0 && dims[i] > 0) {
        scale[i] = size[i] / dims[i];
        autoscale = Math.max(autoscale, scale[i]);
      }
    }
    for (let i = 0; i < 3; i++) if (!(size[i] > 0) && auto[i] && autoscale > 0) scale[i] = autoscale;
    return this.transform(g, M.scaling(scale[0], scale[1], scale[2]));
  }

  // -- output -----------------------------------------------------------------------

  private toMeshes(g: Geo, role: MeshRole, exact: boolean): MeshData[] {
    const out: MeshData[] = [];
    const solids = exact ? [this.materialize(g)].filter((m): m is Manifold => !!m) : g.parts;
    const meshes = solids.filter((m) => !m.isEmpty()).map((m) => this.manifoldToMesh(m, role));
    if (meshes.length) out.push(meshes.length === 1 ? meshes[0] : mergeMeshes(meshes));
    if (g.cs && !g.cs.isEmpty()) out.push(this.crossSectionToMesh(g.cs, g.csColor, role));
    if (g.soups.length) out.push(this.soupsToMesh(g.soups, role));
    return out;
  }

  private manifoldToMesh(m: Manifold, role: MeshRole): MeshData {
    const mesh = m.getMesh();
    const { vertProperties: vp, triVerts: tv, numProp } = mesh;
    const nTri = tv.length / 3;
    const positions = new Float32Array(nTri * 9);
    const triMaterials = new Uint16Array(nTri);
    const materials: Material[] = [];
    const matIndex = new Map<string, number>();
    const materialFor = (id: number, backside: boolean): number => {
      const c = this.idColors.get(id);
      const key = c ? c.join(',') : backside ? 'cut' : 'default';
      let i = matIndex.get(key);
      if (i === undefined) {
        i = materials.length;
        materials.push(c ? { kind: 'color', color: c } : { kind: backside ? 'cut' : 'default' });
        matIndex.set(key, i);
      }
      return i;
    };
    const runIndex = mesh.runIndex;
    const runIds = mesh.runOriginalID;
    const runFlags = (mesh as unknown as { runFlags?: Uint8Array }).runFlags;
    for (let r = 0; r < runIds.length; r++) {
      if (runIndex[r + 1] === runIndex[r]) continue;
      const mat = materialFor(runIds[r], !!runFlags && (runFlags[r] & 1) === 1);
      const t1 = runIndex[r + 1] / 3;
      for (let t = runIndex[r] / 3; t < t1; t++) triMaterials[t] = mat;
    }
    if (runIds.length === 0) materialFor(-1, false);
    for (let t = 0; t < nTri; t++) {
      for (let k = 0; k < 3; k++) {
        const v = tv[t * 3 + k] * numProp;
        positions[t * 9 + k * 3] = vp[v];
        positions[t * 9 + k * 3 + 1] = vp[v + 1];
        positions[t * 9 + k * 3 + 2] = vp[v + 2];
      }
    }
    const edges = this.options.edges === false ? undefined : featureEdges(vp, numProp, tv, this.options.edgeAngle ?? 25);
    return { positions, triMaterials, materials, role, dim: 3, edges };
  }

  private crossSectionToMesh(cs: CrossSection, color: Color | undefined, role: MeshRole): MeshData {
    const polys = cs.toPolygons() as MVec2[][];
    const flat = polys.flat();
    const tris = this.wasm.triangulate(polys) as [number, number, number][];
    const positions = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const p = flat[t[k]];
        positions[i * 9 + k * 3] = p[0];
        positions[i * 9 + k * 3 + 1] = p[1];
        positions[i * 9 + k * 3 + 2] = 0;
      }
    });
    // outline edges
    const edgeList: number[] = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        edgeList.push(a[0], a[1], 0, b[0], b[1], 0);
      }
    }
    return {
      positions,
      triMaterials: new Uint16Array(tris.length),
      materials: [color ? { kind: 'color', color } : { kind: 'default' }],
      role,
      dim: 2,
      edges: new Float32Array(edgeList),
    };
  }

  private soupsToMesh(soups: Soup[], role: MeshRole): MeshData {
    let nTri = 0;
    for (const s of soups) nTri += s.indices.length / 3;
    const positions = new Float32Array(nTri * 9);
    const triMaterials = new Uint16Array(nTri);
    const materials: Material[] = [];
    let t = 0;
    for (const s of soups) {
      const c = this.soupColors[s.colorId];
      const mi = materials.length;
      materials.push(c ? { kind: 'color', color: c } : { kind: 'default' });
      for (let i = 0; i < s.indices.length; i += 3, t++) {
        triMaterials[t] = mi;
        for (let k = 0; k < 3; k++) {
          const v = s.indices[i + k] * 3;
          positions[t * 9 + k * 3] = s.positions[v];
          positions[t * 9 + k * 3 + 1] = s.positions[v + 1];
          positions[t * 9 + k * 3 + 2] = s.positions[v + 2];
        }
      }
    }
    return { positions, triMaterials, materials, role, dim: 3 };
  }
}

// -- mesh builders -------------------------------------------------------------------

function circlePoints(r: number, n: number): MVec2[] {
  const pts: MVec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (360 * i) / n;
    pts.push([r * M.cosd(a), r * M.sind(a)]);
  }
  return pts;
}

/** Sphere tessellated like OpenSCAD: rings at polar angles offset by half a step. */
export function sphereMesh(r: number, fragments: number): { positions: number[]; indices: number[] } {
  const rings = Math.floor((fragments + 1) / 2);
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < rings; i++) {
    const phi = (180 * (i + 0.5)) / rings;
    const rr = r * M.sind(phi);
    const z = r * M.cosd(phi);
    for (const [x, y] of circlePoints(rr, fragments)) positions.push(x, y, z);
  }
  const v = (ring: number, j: number): number => ring * fragments + (j % fragments);
  // top cap (ring 0) seen from above: CCW
  for (let j = 1; j + 1 < fragments; j++) indices.push(v(0, 0), v(0, j), v(0, j + 1));
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < fragments; j++) {
      indices.push(v(i, j), v(i + 1, j), v(i + 1, j + 1));
      indices.push(v(i, j), v(i + 1, j + 1), v(i, j + 1));
    }
  }
  const last = rings - 1;
  for (let j = 1; j + 1 < fragments; j++) indices.push(v(last, 0), v(last, j + 1), v(last, j));
  return { positions, indices };
}

export function cylinderMesh(
  h: number,
  r1: number,
  r2: number,
  n: number,
  center: boolean,
): { positions: number[]; indices: number[] } {
  const z0 = center ? -h / 2 : 0;
  const z1 = z0 + h;
  const positions: number[] = [];
  const indices: number[] = [];
  const bottom = r1 > 0 ? circlePoints(r1, n) : null;
  const top = r2 > 0 ? circlePoints(r2, n) : null;
  const bi = 0;
  if (bottom) for (const [x, y] of bottom) positions.push(x, y, z0);
  else positions.push(0, 0, z0);
  const ti = positions.length / 3;
  if (top) for (const [x, y] of top) positions.push(x, y, z1);
  else positions.push(0, 0, z1);
  const B = (j: number): number => (bottom ? bi + (j % n) : bi);
  const T = (j: number): number => (top ? ti + (j % n) : ti);
  // sides (an apex replaces a missing ring)
  for (let j = 0; j < n; j++) {
    if (bottom) indices.push(B(j), B(j + 1), T(j + 1));
    if (top) indices.push(B(j), T(j + 1), T(j));
  }
  // caps
  if (bottom) for (let j = 1; j + 1 < n; j++) indices.push(B(0), B(j + 1), B(j));
  if (top) for (let j = 1; j + 1 < n; j++) indices.push(T(0), T(j), T(j + 1));
  return { positions, indices };
}

/** Concatenate meshes, remapping their material tables. */
function mergeMeshes(meshes: MeshData[]): MeshData {
  let nTri = 0, nEdge = 0;
  for (const m of meshes) {
    nTri += m.triMaterials.length;
    nEdge += m.edges?.length ?? 0;
  }
  const positions = new Float32Array(nTri * 9);
  const triMaterials = new Uint16Array(nTri);
  const edges = new Float32Array(nEdge);
  const materials: Material[] = [];
  const index = new Map<string, number>();
  let t = 0, e = 0;
  for (const m of meshes) {
    const remap = m.materials.map((mat) => {
      const key = mat.kind === 'color' ? mat.color.join(',') : mat.kind;
      let i = index.get(key);
      if (i === undefined) {
        i = materials.length;
        materials.push(mat);
        index.set(key, i);
      }
      return i;
    });
    positions.set(m.positions, t * 9);
    for (let i = 0; i < m.triMaterials.length; i++) triMaterials[t + i] = remap[m.triMaterials[i]];
    t += m.triMaterials.length;
    if (m.edges) {
      edges.set(m.edges, e);
      e += m.edges.length;
    }
  }
  return { positions, triMaterials, materials, role: meshes[0].role, dim: 3, edges };
}

function signedVolume(p: Float32Array, t: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v;
}

function maxRadius(cs: CrossSection): number {
  let r = 0;
  for (const poly of cs.toPolygons() as MVec2[][]) for (const [x, y] of poly) r = Math.max(r, Math.hypot(x, y));
  return r;
}

function isConvex(cs: CrossSection): boolean {
  const polys = cs.toPolygons() as MVec2[][];
  if (polys.length !== 1) return false;
  const p = polys[0];
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], c = p[(i + 2) % p.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Compute edges where adjacent faces meet at an angle above the threshold. */
export function featureEdges(vp: Float32Array, numProp: number, tv: Uint32Array, angleDeg: number): Float32Array {
  const nTri = tv.length / 3;
  const normals = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = tv[t * 3] * numProp, b = tv[t * 3 + 1] * numProp, c = tv[t * 3 + 2] * numProp;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
  }
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const edgeTri = new Map<number, number>();
  const out: number[] = [];
  const nVert = vp.length / numProp;
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tv[t * 3 + k], b = tv[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a * nVert + b : b * nVert + a;
      const other = edgeTri.get(key);
      if (other === undefined) {
        edgeTri.set(key, t);
        continue;
      }
      edgeTri.delete(key);
      const d = normals[t * 3] * normals[other * 3] + normals[t * 3 + 1] * normals[other * 3 + 1] + normals[t * 3 + 2] * normals[other * 3 + 2];
      if (d < cosT) {
        out.push(vp[a * numProp], vp[a * numProp + 1], vp[a * numProp + 2], vp[b * numProp], vp[b * numProp + 1], vp[b * numProp + 2]);
      }
    }
  }
  // unmatched edges (boundaries) are always drawn
  for (const key of edgeTri.keys()) {
    const a = Math.floor(key / nVert), b = key % nVert;
    out.push(vp[a * numProp], vp[a * numProp + 1], vp[a * numProp + 2], vp[b * numProp], vp[b * numProp + 1], vp[b * numProp + 2]);
  }
  return new Float32Array(out);
}

export type { Vec2 };
