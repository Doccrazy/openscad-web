import type { Expr, Parameter } from '../lang/ast';
import type { Scope } from './scope';

/**
 * Runtime values. `undefined` represents OpenSCAD's `undef`, arrays are vectors.
 */
export type Value =
  | undefined
  | number
  | boolean
  | string
  | Value[]
  | RangeValue
  | FunctionValue
  | ObjectValue;

export class RangeValue {
  constructor(
    public readonly start: number,
    public readonly step: number,
    public readonly end: number,
  ) {}

  /** Number of elements (capped to avoid runaway loops). */
  get count(): number {
    const { start, step, end } = this;
    if (!isFinite(start) || !isFinite(step) || !isFinite(end) || step === 0) return 0;
    if ((step > 0 && start > end) || (step < 0 && start < end)) return 0;
    return Math.floor((end - start) / step + 1e-10) + 1;
  }

  *[Symbol.iterator](): Iterator<number> {
    const n = this.count;
    for (let i = 0; i < n; i++) yield this.start + i * this.step;
  }

  toArray(): number[] {
    return [...this];
  }
}

export class FunctionValue {
  constructor(
    public readonly params: Parameter[],
    public readonly body: Expr,
    public readonly scope: Scope,
    public readonly name = '',
  ) {}
}

export class ObjectValue {
  constructor(public readonly entries: Map<string, Value>) {}
}

export const isVector = (v: Value): v is Value[] => Array.isArray(v);
export const isNum = (v: Value): v is number => typeof v === 'number';
export const isFiniteNum = (v: Value): v is number => typeof v === 'number' && Number.isFinite(v);

export function truthy(v: Value): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function typeName(v: Value): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'vector';
  if (v instanceof RangeValue) return 'range';
  if (v instanceof FunctionValue) return 'function';
  return 'object';
}

/** Format a number the way OpenSCAD does (printf `%g`-like, 6 significant digits). */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) {
    // integers keep all digits if they fit into the 6 digit precision, else %g
    if (Math.abs(n) < 1e6) return String(n);
  }
  const exp = Math.floor(Math.log10(Math.abs(n)));
  let s: string;
  if (exp < -5 || exp >= 6) {
    s = n.toExponential(5);
    let [mant, e] = s.split('e');
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const sign = e[0] === '-' ? '-' : '+';
    let digits = e.replace(/^[+-]/, '');
    if (digits.length < 2) digits = '0' + digits;
    return `${mant}e${sign}${digits}`;
  }
  s = n.toPrecision(6);
  if (s.includes('e')) return formatNumber(Number(s));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + '"';
}

/** Convert a value to its OpenSCAD textual representation (`str()` semantics). */
export function valueToString(v: Value, quoteStrings = false): string {
  if (v === undefined) return 'undef';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return quoteStrings ? quote(v) : v;
  if (Array.isArray(v)) return '[' + v.map((x) => valueToString(x, true)).join(', ') + ']';
  if (v instanceof RangeValue)
    return `[${formatNumber(v.start)} : ${formatNumber(v.step)} : ${formatNumber(v.end)}]`;
  if (v instanceof FunctionValue) return `function(${v.params.map((p) => p.name).join(', ')})`;
  if (v instanceof ObjectValue)
    return '{ ' + [...v.entries].map(([k, x]) => `${k} = ${valueToString(x, true)};`).join(' ') + ' }';
  return String(v);
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof RangeValue && b instanceof RangeValue)
    return a.start === b.start && a.step === b.step && a.end === b.end;
  return false;
}

/** Iterate a value as OpenSCAD `for` would. */
export function iterateValue(v: Value): Iterable<Value> {
  if (Array.isArray(v)) return v;
  if (v instanceof RangeValue) return v;
  if (typeof v === 'string') return [...v];
  if (v instanceof ObjectValue) return [...v.entries.keys()];
  if (v === undefined) return [];
  return [v];
}

// ---------------------------------------------------------------------------
// Arithmetic

function elementwise(a: Value[], b: Value[], f: (x: Value, y: Value) => Value): Value {
  const n = Math.min(a.length, b.length);
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = f(a[i], b[i]);
  return out;
}

export function add(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return elementwise(a, b, add);
  return undefined;
}

export function sub(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (Array.isArray(a) && Array.isArray(b)) return elementwise(a, b, sub);
  return undefined;
}

export function neg(a: Value): Value {
  if (typeof a === 'number') return -a;
  if (Array.isArray(a)) return a.map(neg);
  return undefined;
}

function isNumVec(v: Value[]): v is number[] {
  for (const x of v) if (typeof x !== 'number') return false;
  return true;
}

function dot(a: Value[], b: Value[]): Value {
  if (a.length !== b.length) return undefined;
  if (isNumVec(a) && isNumVec(b)) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
  // vector of vectors times vector (row combination)
  let acc: Value = undefined;
  for (let i = 0; i < a.length; i++) {
    const t = mul(a[i], b[i]);
    acc = i === 0 ? t : add(acc, t);
  }
  return acc;
}

export function mul(a: Value, b: Value): Value {
  if (typeof a === 'number') {
    if (typeof b === 'number') return a * b;
    if (Array.isArray(b)) return b.map((x) => mul(a, x));
    return undefined;
  }
  if (Array.isArray(a)) {
    if (typeof b === 'number') return a.map((x) => mul(x, b));
    if (Array.isArray(b)) {
      if (a.length === 0 || b.length === 0) return undefined;
      const aMat = Array.isArray(a[0]);
      const bMat = Array.isArray(b[0]);
      if (!aMat && !bMat) return dot(a, b);
      if (aMat && !bMat) {
        // matrix * vector
        const out: Value[] = [];
        for (const row of a) {
          if (!Array.isArray(row)) return undefined;
          const d = dot(row, b);
          if (d === undefined) return undefined;
          out.push(d);
        }
        return out;
      }
      if (!aMat && bMat) {
        // vector * matrix
        if (a.length !== b.length) return undefined;
        const cols = (b[0] as Value[]).length;
        const out: Value[] = [];
        for (let j = 0; j < cols; j++) {
          let s = 0;
          for (let i = 0; i < a.length; i++) {
            const x = a[i];
            const y = (b[i] as Value[])[j];
            if (typeof x !== 'number' || typeof y !== 'number') return undefined;
            s += x * y;
          }
          out.push(s);
        }
        return out;
      }
      // matrix * matrix
      const cols = (b[0] as Value[]).length;
      const out: Value[] = [];
      for (const row of a) {
        if (!Array.isArray(row) || row.length !== b.length) return undefined;
        const r: Value[] = [];
        for (let j = 0; j < cols; j++) {
          let s = 0;
          for (let k = 0; k < row.length; k++) {
            const x = row[k];
            const y = (b[k] as Value[])[j];
            if (typeof x !== 'number' || typeof y !== 'number') return undefined;
            s += x * y;
          }
          r.push(s);
        }
        out.push(r);
      }
      return out;
    }
  }
  return undefined;
}

export function div(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  if (Array.isArray(a) && typeof b === 'number') return a.map((x) => div(x, b));
  if (typeof a === 'number' && Array.isArray(b)) return b.map((x) => div(a, x));
  return undefined;
}

export function mod(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a % b;
  return undefined;
}

export function pow(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return Math.pow(a, b);
  return undefined;
}

export function compare(op: '<' | '<=' | '>' | '>=', a: Value, b: Value): Value {
  if (
    (typeof a === 'number' || typeof a === 'boolean') &&
    (typeof b === 'number' || typeof b === 'boolean')
  ) {
    const x = Number(a);
    const y = Number(b);
    switch (op) {
      case '<': return x < y;
      case '<=': return x <= y;
      case '>': return x > y;
      case '>=': return x >= y;
    }
  }
  if (typeof a === 'string' && typeof b === 'string') {
    switch (op) {
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // lexicographic comparison
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (valuesEqual(a[i], b[i])) continue;
      const lt = compare('<', a[i], b[i]);
      if (lt === undefined) return undefined;
      return op === '<' || op === '<=' ? lt : !lt;
    }
    switch (op) {
      case '<': return a.length < b.length;
      case '<=': return a.length <= b.length;
      case '>': return a.length > b.length;
      case '>=': return a.length >= b.length;
    }
  }
  return undefined;
}

/** Interpret a value as a numeric vector of given length, or undefined. */
export function toNumVec(v: Value, minLen = 0): number[] | undefined {
  if (!Array.isArray(v) || v.length < minLen) return undefined;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number') return undefined;
    out.push(x);
  }
  return out;
}
