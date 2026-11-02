import type { Argument, ModuleInstantiation } from '../lang/ast';
import { hashBytes, parseHeightmap, parseOBJ, parseOFF, parseSTL } from '../geometry/importers';
import * as M from '../math/mat4';
import { FnArgs, bindArgs } from './builtin-functions';
import { parseColorString } from './colors';
import { Color, Fragments, GeomNode, Vec2, Vec3, fragmentsForRadius } from './csg-tree';
import type { Interpreter } from './interpreter';
import { EvalError, group } from './interpreter';
import { Scope } from './scope';
import { RangeValue, Value, toNumVec, truthy } from './values';

export interface ModuleCall {
  interp: Interpreter;
  stmt: ModuleInstantiation;
  /** Scope for this call; `$` arguments are set here by evalArgs(). */
  scope: Scope;
  args: Argument[];
  /** Evaluate arguments (must be called before children()). */
  evalArgs(): FnArgs;
  /** Evaluate the child statements. */
  children(): GeomNode[];
}

export type BuiltinModule = (call: ModuleCall) => GeomNode | undefined;

const num = (v: Value, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isNum = (v: Value): v is number => typeof v === 'number' && Number.isFinite(v);

function frag(scope: Scope): Fragments {
  return {
    fn: num(scope.lookup('$fn'), 0),
    fa: Math.max(0.01, num(scope.lookup('$fa'), 12)),
    fs: Math.max(0.01, num(scope.lookup('$fs'), 2)),
  };
}

function params(call: ModuleCall, names: string[]): Value[] {
  return bindArgs(call.evalArgs(), names);
}

function vec3(v: Value, fill: number): Vec3 | undefined {
  if (isNum(v)) return [v, v, v];
  const a = toNumVec(v);
  if (!a || a.length === 0) return undefined;
  return [a[0], a[1] ?? fill, a[2] ?? fill];
}

/** Wrap evaluated children in a node of the given type. */
function wrap(type: 'group' | 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski' | 'render') {
  return (call: ModuleCall): GeomNode | undefined => {
    call.evalArgs();
    const children = call.children();
    if (!children.length) return undefined;
    if (type === 'group' || type === 'union' || type === 'render') {
      return children.length === 1 ? children[0] : { type, children };
    }
    return { type, children };
  };
}

function transform(call: ModuleCall, m: M.Mat4 | undefined): GeomNode | undefined {
  const children = call.children();
  if (!children.length) return undefined;
  if (!m) return group(children);
  if (M.isIdentity(m)) return group(children);
  // fold nested transforms
  if (children.length === 1 && children[0].type === 'transform') {
    return { type: 'transform', matrix: M.multiply(m, children[0].matrix), children: children[0].children };
  }
  return { type: 'transform', matrix: m, children };
}

function toColor(c: Value, alpha: Value, call: ModuleCall): Color | undefined {
  let col: Color | undefined;
  if (typeof c === 'string') {
    col = parseColorString(c);
    if (!col) call.interp.warn(`Unable to parse color "${c}"`, call.stmt);
  } else {
    const v = toNumVec(c);
    if (v && v.length >= 3) col = [v[0], v[1], v[2], v.length >= 4 ? v[3] : 1];
  }
  if (!col) return undefined;
  if (isNum(alpha)) col = [col[0], col[1], col[2], alpha];
  return col.map((x) => Math.min(1, Math.max(0, x))) as Color;
}

function indicesOf(v: Value): number[] | undefined {
  if (isNum(v)) return [Math.floor(v)];
  if (Array.isArray(v)) return v.filter(isNum).map(Math.floor);
  if (v instanceof RangeValue) return v.toArray().map(Math.floor);
  return undefined;
}

function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export const BUILTIN_MODULES: Record<string, BuiltinModule> = {
  // -- 3D primitives -------------------------------------------------------------
  cube(call) {
    const [size, center] = params(call, ['size', 'center']);
    const s = vec3(size ?? 1, 1);
    if (!s) return undefined;
    if (s.some((x) => x <= 0)) return undefined;
    return { type: 'cube', size: s, center: truthy(center) };
  },

  sphere(call) {
    const [r0, d] = params(call, ['r', 'd']);
    const r = isNum(d) ? d / 2 : num(r0, 1);
    if (r <= 0) return undefined;
    return { type: 'sphere', r, segments: fragmentsForRadius(r, frag(call.scope)) };
  },

  cylinder(call) {
    const [h0, r1a, r2a, center, r, d, d1, d2] = params(call, ['h', 'r1', 'r2', 'center', 'r', 'd', 'd1', 'd2']);
    const h = num(h0, 1);
    let r1 = 1, r2 = 1;
    if (isNum(r)) r1 = r2 = r;
    if (isNum(d)) r1 = r2 = d / 2;
    if (isNum(r1a)) r1 = r1a;
    if (isNum(r2a)) r2 = r2a;
    if (isNum(d1)) r1 = d1 / 2;
    if (isNum(d2)) r2 = d2 / 2;
    if (h <= 0 || r1 < 0 || r2 < 0 || (r1 === 0 && r2 === 0)) return undefined;
    return {
      type: 'cylinder',
      h,
      r1,
      r2,
      center: truthy(center),
      segments: fragmentsForRadius(Math.max(r1, r2), frag(call.scope)),
    };
  },

  polyhedron(call) {
    const [points, faces0, , triangles] = params(call, ['points', 'faces', 'convexity', 'triangles']);
    const faces = faces0 ?? triangles;
    if (!Array.isArray(points) || !Array.isArray(faces)) return undefined;
    const pts: Vec3[] = [];
    for (const p of points) {
      const v = toNumVec(p);
      if (!v || v.length < 3) {
        call.interp.warn('Unable to convert point to a vector of 3 numbers', call.stmt);
        return undefined;
      }
      pts.push([v[0], v[1], v[2]]);
    }
    const fs: number[][] = [];
    for (const f of faces) {
      const v = toNumVec(f);
      if (v && v.length >= 3 && v.every((i) => i >= 0 && i < pts.length)) fs.push(v.map(Math.floor));
    }
    if (!fs.length) return undefined;
    return { type: 'polyhedron', points: pts, faces: fs };
  },

  // -- 2D primitives -------------------------------------------------------------
  square(call) {
    const [size, center] = params(call, ['size', 'center']);
    let s: Vec2;
    if (isNum(size ?? 1)) s = [num(size, 1), num(size, 1)];
    else {
      const v = toNumVec(size);
      if (!v || v.length < 2) return undefined;
      s = [v[0], v[1]];
    }
    if (s[0] <= 0 || s[1] <= 0) return undefined;
    return { type: 'square', size: s, center: truthy(center) };
  },

  circle(call) {
    const [r0, d] = params(call, ['r', 'd']);
    const r = isNum(d) ? d / 2 : num(r0, 1);
    if (r <= 0) return undefined;
    return { type: 'circle', r, segments: fragmentsForRadius(r, frag(call.scope)) };
  },

  polygon(call) {
    const [points, paths] = params(call, ['points', 'paths', 'convexity']);
    if (!Array.isArray(points)) return undefined;
    const pts: Vec2[] = [];
    for (const p of points) {
      const v = toNumVec(p);
      if (!v || v.length < 2) return undefined;
      pts.push([v[0], v[1]]);
    }
    let ps: number[][] | undefined;
    if (Array.isArray(paths)) {
      ps = [];
      for (const path of paths) {
        const v = toNumVec(path);
        if (v) ps.push(v.filter((i) => i >= 0 && i < pts.length).map(Math.floor));
      }
    }
    if (pts.length < 3) return undefined;
    return { type: 'polygon', points: pts, paths: ps };
  },

  text(call) {
    const [text, size, font, halign, valign, spacing, direction] = params(call, [
      'text', 'size', 'font', 'halign', 'valign', 'spacing', 'direction', 'language', 'script',
    ]);
    if (text === undefined) return undefined;
    const str = typeof text === 'string' ? text : String(text);
    if (!str.length) return undefined;
    const f = frag(call.scope);
    const sz = num(size, 10);
    return {
      type: 'text',
      text: str,
      size: sz,
      font: typeof font === 'string' ? font : '',
      halign: typeof halign === 'string' ? halign : 'left',
      valign: typeof valign === 'string' ? valign : 'baseline',
      spacing: num(spacing, 1),
      direction: typeof direction === 'string' ? direction : 'ltr',
      // OpenSCAD uses $fn for curve subdivision of glyph outlines
      segments: f.fn > 0 ? Math.max(1, Math.ceil(f.fn / 4)) : Math.max(2, Math.ceil(fragmentsForRadius(sz / 2, f) / 8)),
    };
  },

  // -- transformations -------------------------------------------------------------
  translate(call) {
    const [v] = params(call, ['v']);
    const t = vec3(v, 0);
    return transform(call, t && !isNum(v) ? M.translation(t[0], t[1], t[2]) : undefined);
  },

  rotate(call) {
    const [a, v] = params(call, ['a', 'v']);
    let m: M.Mat4 | undefined;
    if (isNum(a)) {
      const axis = toNumVec(v);
      m = axis && axis.length >= 3 ? M.rotationAxis(a, [axis[0], axis[1], axis[2]]) : M.rotationZ(a);
    } else {
      const r = toNumVec(a);
      if (r) {
        const [x = 0, y = 0, z = 0] = r;
        m = M.multiply(M.rotationZ(z), M.multiply(M.rotationY(y), M.rotationX(x)));
      }
    }
    return transform(call, m);
  },

  scale(call) {
    const [v] = params(call, ['v']);
    const s = vec3(v, 1);
    return transform(call, s ? M.scaling(s[0], s[1], s[2]) : undefined);
  },

  mirror(call) {
    const [v] = params(call, ['v']);
    const n = vec3(v, 0);
    return transform(call, n && !isNum(v) ? M.mirror(n) : undefined);
  },

  multmatrix(call) {
    const [mv] = params(call, ['m']);
    if (!Array.isArray(mv)) return transform(call, undefined);
    const m = M.identity();
    for (let r = 0; r < 4 && r < mv.length; r++) {
      const row = toNumVec(mv[r]);
      if (!row) continue;
      for (let c = 0; c < 4 && c < row.length; c++) m[c * 4 + r] = row[c];
    }
    return transform(call, m);
  },

  color(call) {
    const [c, alpha] = params(call, ['c', 'alpha']);
    const children = call.children();
    if (!children.length) return undefined;
    const col = toColor(c, alpha, call);
    if (!col) return group(children);
    return { type: 'color', color: col, children };
  },

  resize(call) {
    const [ns, auto] = params(call, ['newsize', 'auto', 'convexity']);
    const children = call.children();
    if (!children.length) return undefined;
    const v = toNumVec(ns);
    if (!v) return group(children);
    const size: Vec3 = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    let a: [boolean, boolean, boolean] = [false, false, false];
    if (Array.isArray(auto)) a = [truthy(auto[0]), truthy(auto[1]), truthy(auto[2])];
    else if (truthy(auto)) a = [true, true, true];
    return { type: 'resize', size, auto: a, children };
  },

  offset(call) {
    const [r, delta, chamfer] = params(call, ['r', 'delta', 'chamfer']);
    const children = call.children();
    if (!children.length) return undefined;
    const f = frag(call.scope);
    if (isNum(r)) return { type: 'offset', r, chamfer: false, frag: f, children };
    return { type: 'offset', delta: num(delta, 1), chamfer: truthy(chamfer), frag: f, children };
  },

  // -- CSG ---------------------------------------------------------------------------
  union: wrap('union'),
  group: wrap('group'),
  render: wrap('render'),
  difference: wrap('difference'),
  intersection: wrap('intersection'),
  hull: wrap('hull'),
  minkowski: wrap('minkowski'),

  // -- extrusions --------------------------------------------------------------------
  linear_extrude(call) {
    const [height, center, , twist, slices, scale, v] = params(call, [
      'height', 'center', 'convexity', 'twist', 'slices', 'scale', 'v',
    ]);
    const children = call.children();
    if (!children.length) return undefined;
    let h = num(height, 100);
    const dir = toNumVec(v);
    let pre: M.Mat4 | undefined;
    if (dir && dir.length >= 3 && Math.hypot(dir[0], dir[1], dir[2]) > 0) {
      // extrusion along a vector: shear so z maps onto v
      if (!isNum(height)) h = Math.hypot(dir[0], dir[1], dir[2]);
      const len = h / dir[2];
      pre = [1, 0, 0, 0, 0, 1, 0, 0, (dir[0] * len) / h, (dir[1] * len) / h, 1, 0, 0, 0, 0, 1];
    }
    if (h <= 0) return undefined;
    let sc: Vec2 = [1, 1];
    if (isNum(scale)) sc = [scale, scale];
    else {
      const s = toNumVec(scale);
      if (s && s.length >= 2) sc = [s[0], s[1]];
    }
    const node: GeomNode = {
      type: 'linear_extrude',
      height: h,
      center: truthy(center),
      twist: num(twist, 0),
      slices: isNum(slices) && slices >= 1 ? Math.floor(slices) : undefined,
      scale: [Math.max(0, sc[0]), Math.max(0, sc[1])],
      frag: frag(call.scope),
      children,
    };
    return pre ? { type: 'transform', matrix: pre, children: [node] } : node;
  },

  rotate_extrude(call) {
    const [angle] = params(call, ['angle', 'convexity']);
    const children = call.children();
    if (!children.length) return undefined;
    let a = num(angle, 360);
    if (a === 0) return undefined;
    a = Math.max(-360, Math.min(360, a));
    return { type: 'rotate_extrude', angle: a, frag: frag(call.scope), children };
  },

  projection(call) {
    const [cut] = params(call, ['cut', 'convexity']);
    const children = call.children();
    if (!children.length) return undefined;
    return { type: 'projection', cut: truthy(cut), children };
  },

  // -- files -------------------------------------------------------------------------
  import(call) {
    const [file, , , , , center] = params(call, ['file', 'convexity', 'layer', 'origin', 'scale', 'center']);
    if (typeof file !== 'string') return undefined;
    const ext = extOf(file);
    if (!['stl', 'off', 'obj'].includes(ext)) {
      call.interp.warn(`import(): unsupported file format '${ext}'`, call.stmt);
      return undefined;
    }
    const r = call.interp.readFile(file, call.stmt.file, ext === 'stl', call.stmt);
    if (!r) return undefined;
    const mesh = ext === 'stl' ? parseSTL(r.data) : ext === 'off' ? parseOFF(r.data) : parseOBJ(r.data);
    if (!mesh.indices.length) return undefined;
    if (truthy(center)) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], mesh.positions[i]);
        hi[i % 3] = Math.max(hi[i % 3], mesh.positions[i]);
      }
      for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] -= (lo[i % 3] + hi[i % 3]) / 2;
    }
    return { type: 'mesh', key: `${r.path}#${hashBytes(r.data)}#${truthy(center)}`, positions: mesh.positions, indices: mesh.indices };
  },

  surface(call) {
    const [file, center, invert] = params(call, ['file', 'center', 'invert', 'convexity']);
    if (typeof file !== 'string') return undefined;
    if (extOf(file) !== 'dat' && extOf(file) !== 'txt') {
      call.interp.warn(`surface(): only .dat height maps are supported`, call.stmt);
      return undefined;
    }
    const r = call.interp.readFile(file, call.stmt.file, false, call.stmt);
    if (!r) return undefined;
    const mesh = parseHeightmap(r.data, truthy(center), truthy(invert));
    if (!mesh) return undefined;
    return {
      type: 'mesh',
      key: `surface:${r.path}#${hashBytes(r.data)}#${truthy(center)}${truthy(invert)}`,
      positions: mesh.positions,
      indices: mesh.indices,
    };
  },

  // -- control flow --------------------------------------------------------------------
  children(call) {
    const [index] = params(call, ['index']);
    const idx = call.args.length ? indicesOf(index) : undefined;
    if (call.args.length && !idx) return undefined;
    return group(call.interp.evalChildren(call.scope, idx, call.stmt));
  },

  echo(call) {
    call.interp.doEcho(call.args, call.scope, call.stmt);
    return group(call.children());
  },

  assert(call) {
    call.interp.doAssert(call.args, call.scope, call.stmt);
    return group(call.children());
  },

  let(call) {
    const s = new Scope(call.scope);
    for (const a of call.args) {
      if (a.name === undefined) continue;
      s.set(a.name, call.interp.evalExpr(a.value, s));
    }
    return group(call.interp.evalChildBlock(call.stmt.children, s));
  },

  for(call) {
    return forLoop(call, 'group');
  },

  intersection_for(call) {
    return forLoop(call, 'intersection');
  },
};

function forLoop(call: ModuleCall, type: 'group' | 'intersection'): GeomNode | undefined {
  const assigns = call.args.filter((a) => a.name !== undefined) as { name: string; value: Argument['value'] }[];
  // $-variables given as loop args are loop variables in OpenSCAD as well
  const out: GeomNode[] = [];
  if (!assigns.length) {
    if (call.args.length) {
      // for([list]) – iterate without variable
      const v = call.interp.evalExpr(call.args[0].value, call.scope);
      call.interp.forEachAssignment([{ name: '$__unused', value: v }], call.scope, (s) => {
        const g = group(call.interp.evalChildBlock(call.stmt.children, s));
        if (g) out.push(g);
      }, call.stmt, true);
    }
  } else {
    call.interp.forEachAssignment(assigns, call.scope, (s) => {
      const g = group(call.interp.evalChildBlock(call.stmt.children, s));
      if (g) out.push(g);
    }, call.stmt);
  }
  if (!out.length) return undefined;
  if (type === 'intersection') return out.length === 1 ? out[0] : { type: 'intersection', children: out };
  return out.length === 1 ? out[0] : { type: 'group', children: out };
}

