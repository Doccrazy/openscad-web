import { cosd, sind } from '../math/mat4';
import {
  FunctionValue,
  ObjectValue,
  RangeValue,
  Value,
  isVector,
  toNumVec,
  valueToString,
  valuesEqual,
} from './values';

export interface FnArgs {
  positional: Value[];
  named: Map<string, Value>;
}

export interface FnContext {
  warn(msg: string): void;
  /** Name of the n-th enclosing module (for parent_module). */
  parentModule(n: number): Value;
}

export type BuiltinFunction = (args: FnArgs, ctx: FnContext) => Value;

/** Bind positional / named arguments to parameter names. */
export function bindArgs(args: FnArgs, params: string[]): Value[] {
  const out: Value[] = params.map((_, i) => args.positional[i]);
  for (const [k, v] of args.named) {
    const idx = params.indexOf(k);
    if (idx >= 0) out[idx] = v;
  }
  return out;
}

const num = (v: Value): number | undefined => (typeof v === 'number' ? v : undefined);

function math1(f: (x: number) => number): BuiltinFunction {
  return (a) => {
    const x = a.positional[0];
    return typeof x === 'number' ? f(x) : undefined;
  };
}

const rad2deg = 180 / Math.PI;

function minMax(isMin: boolean): BuiltinFunction {
  return (a) => {
    let list: Value[] = a.positional;
    if (list.length === 1 && Array.isArray(list[0])) list = list[0];
    if (list.length === 0) return undefined;
    let best: number | undefined;
    for (const v of list) {
      if (typeof v !== 'number') return undefined;
      if (best === undefined || (isMin ? v < best : v > best) || Number.isNaN(v)) best = v;
    }
    return best;
  };
}

/** Deterministic PRNG for rands() with seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function searchImpl(match: Value, table: Value, numReturns: number, indexCol: number): Value {
  const tableArr: Value[] =
    typeof table === 'string' ? Array.from(table) : Array.isArray(table) ? table : table instanceof RangeValue ? table.toArray() : [];
  const elem = (i: number): Value => {
    const t = tableArr[i];
    return Array.isArray(t) ? t[indexCol] : t;
  };
  const findAll = (needle: Value): number[] => {
    const res: number[] = [];
    for (let i = 0; i < tableArr.length; i++) {
      if (valuesEqual(elem(i), needle)) {
        res.push(i);
        if (numReturns > 0 && res.length >= numReturns) break;
      }
    }
    return res;
  };
  if (typeof match === 'number' || typeof match === 'boolean' || match === undefined) {
    return findAll(match);
  }
  if (typeof match === 'string') {
    const out: Value[] = [];
    for (const ch of Array.from(match)) {
      const r = findAll(ch);
      if (numReturns === 1) {
        if (r.length) out.push(r[0]);
      } else out.push(r);
    }
    return out;
  }
  if (Array.isArray(match)) {
    const out: Value[] = [];
    for (const m of match) {
      const r = findAll(m);
      if (numReturns === 1) out.push(r.length ? r[0] : []);
      else out.push(r);
    }
    return out;
  }
  return undefined;
}

export const BUILTIN_FUNCTIONS: Record<string, BuiltinFunction> = {
  abs: math1(Math.abs),
  sign: math1((x) => (x > 0 ? 1 : x < 0 ? -1 : 0)),
  sin: math1(sind),
  cos: math1(cosd),
  tan: math1((x) => {
    const c = cosd(x);
    return c === 0 ? (sind(x) > 0 ? Infinity : -Infinity) : sind(x) / c;
  }),
  asin: math1((x) => Math.asin(x) * rad2deg),
  acos: math1((x) => Math.acos(x) * rad2deg),
  atan: math1((x) => Math.atan(x) * rad2deg),
  atan2: (a) => {
    const [y, x] = a.positional;
    return typeof y === 'number' && typeof x === 'number' ? Math.atan2(y, x) * rad2deg : undefined;
  },
  floor: math1(Math.floor),
  ceil: math1(Math.ceil),
  round: math1((x) => (x < 0 ? -Math.round(-x) : Math.round(x))),
  ln: math1(Math.log),
  log: (a) => {
    const [x, y] = a.positional;
    if (typeof x === 'number' && typeof y === 'number') return Math.log(y) / Math.log(x);
    return typeof x === 'number' ? Math.log10(x) : undefined;
  },
  pow: (a) => {
    const [x, y] = a.positional;
    return typeof x === 'number' && typeof y === 'number' ? Math.pow(x, y) : undefined;
  },
  sqrt: math1(Math.sqrt),
  exp: math1(Math.exp),
  min: minMax(true),
  max: minMax(false),
  norm: (a) => {
    const v = toNumVec(a.positional[0]);
    if (!v) return undefined;
    let s = 0;
    for (const x of v) s += x * x;
    return Math.sqrt(s);
  },
  cross: (a) => {
    const u = toNumVec(a.positional[0]);
    const v = toNumVec(a.positional[1]);
    if (!u || !v) return undefined;
    if (u.length === 2 && v.length === 2) return u[0] * v[1] - u[1] * v[0];
    if (u.length !== 3 || v.length !== 3) return undefined;
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  },
  len: (a) => {
    const v = a.positional[0];
    if (typeof v === 'string') return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof RangeValue) return v.count;
    if (v instanceof ObjectValue) return v.entries.size;
    return undefined;
  },
  concat: (a) => {
    const out: Value[] = [];
    for (const v of a.positional) {
      if (Array.isArray(v)) for (const x of v) out.push(x);
      else out.push(v);
    }
    return out;
  },
  lookup: (a) => {
    const key = num(a.positional[0]);
    const table = a.positional[1];
    if (key === undefined || !Array.isArray(table) || table.length === 0) return undefined;
    const rows: [number, Value][] = [];
    for (const r of table) {
      if (Array.isArray(r) && typeof r[0] === 'number') rows.push([r[0], r[1]]);
    }
    if (!rows.length) return undefined;
    // OpenSCAD requires sorted tables; tolerate unsorted ones
    let lo = rows[0], hi = rows[0];
    for (const r of rows) {
      if (r[0] < lo[0]) lo = r;
      if (r[0] > hi[0]) hi = r;
    }
    if (key <= lo[0]) return lo[1];
    if (key >= hi[0]) return hi[1];
    let below = lo, above = hi;
    for (const r of rows) {
      if (r[0] <= key && r[0] >= below[0]) below = r;
      if (r[0] >= key && r[0] <= above[0]) above = r;
    }
    if (above[0] === below[0]) return below[1];
    const t = (key - below[0]) / (above[0] - below[0]);
    const b = below[1], c = above[1];
    if (typeof b === 'number' && typeof c === 'number') return b + (c - b) * t;
    const bv = toNumVec(b), cv = toNumVec(c);
    if (bv && cv && bv.length === cv.length) return bv.map((x, i) => x + (cv[i] - x) * t);
    return undefined;
  },
  str: (a) => a.positional.map((v) => valueToString(v)).join(''),
  chr: (a) => {
    let out = '';
    const add = (v: Value): void => {
      if (typeof v === 'number') {
        if (v > 0 && v <= 0x10ffff && Number.isInteger(v)) out += String.fromCodePoint(v);
      } else if (Array.isArray(v)) v.forEach(add);
      else if (v instanceof RangeValue) for (const x of v) add(x);
    };
    a.positional.forEach(add);
    return out;
  },
  ord: (a) => {
    const s = a.positional[0];
    if (typeof s !== 'string') return undefined;
    const chars = Array.from(s);
    return chars.length === 1 ? chars[0].codePointAt(0) : undefined;
  },
  search: (a) => {
    const [match, table, nr, ic] = bindArgs(a, ['match_value', 'string_or_vector', 'num_returns_per_match', 'index_col_num']);
    return searchImpl(match, table, typeof nr === 'number' ? nr : 1, typeof ic === 'number' ? ic : 0);
  },
  rands: (a) => {
    const [mn, mx, count, seed] = bindArgs(a, ['min_value', 'max_value', 'value_count', 'seed_value']);
    if (typeof mn !== 'number' || typeof mx !== 'number' || typeof count !== 'number') return undefined;
    const rnd = typeof seed === 'number' ? mulberry32(Math.floor(seed * 1000003)) : Math.random;
    const out: number[] = [];
    for (let i = 0; i < Math.min(count, 1e7); i++) out.push(mn + rnd() * (mx - mn));
    return out;
  },
  version: () => [2021, 1, 0],
  version_num: () => 20210100,
  is_undef: (a) => a.positional[0] === undefined,
  is_bool: (a) => typeof a.positional[0] === 'boolean',
  is_num: (a) => typeof a.positional[0] === 'number' && !Number.isNaN(a.positional[0]),
  is_string: (a) => typeof a.positional[0] === 'string',
  is_list: (a) => isVector(a.positional[0]),
  is_function: (a) => a.positional[0] instanceof FunctionValue,
  is_object: (a) => a.positional[0] instanceof ObjectValue,
  parent_module: (a, ctx) => ctx.parentModule(typeof a.positional[0] === 'number' ? a.positional[0] : 1),
  object: (a) => {
    const m = new Map<string, Value>();
    for (const v of a.positional) {
      if (v instanceof ObjectValue) for (const [k, x] of v.entries) m.set(k, x);
      else if (Array.isArray(v))
        for (const kv of v) if (Array.isArray(kv) && typeof kv[0] === 'string') m.set(kv[0], kv[1]);
    }
    for (const [k, v] of a.named) m.set(k, v);
    return new ObjectValue(m);
  },
  has_key: (a) => {
    const [o, k] = a.positional;
    return o instanceof ObjectValue && typeof k === 'string' ? o.entries.has(k) : false;
  },
};
