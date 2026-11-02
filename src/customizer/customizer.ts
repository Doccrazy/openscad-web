import type { Assignment, Expr } from '../lang/ast';
import type { Comment } from '../lang/lexer';
import { isExpr, parse, parseExpression } from '../lang/parser';
import type { Value } from '../eval/values';
import { valueToString } from '../eval/values';

export type CustomizerWidget =
  | { kind: 'slider'; min: number; max: number; step: number }
  | { kind: 'spinbox'; step: number; min?: number; max?: number }
  | { kind: 'dropdown'; options: { value: Value; label: string }[] }
  | { kind: 'checkbox' }
  | { kind: 'text'; maxLength?: number }
  | { kind: 'vector'; length: number; min?: number; max?: number; step: number };

export interface CustomizerParameter {
  name: string;
  /** Tab / group name ("Parameters" if none is given). */
  group: string;
  description?: string;
  type: 'number' | 'string' | 'boolean' | 'vector';
  /** Value as written in the source code. */
  initial: Value;
  widget: CustomizerWidget;
  /** 1-based line of the assignment. */
  line: number;
}

export interface CustomizerGroup {
  name: string;
  parameters: CustomizerParameter[];
}

const DEFAULT_GROUP = 'Parameters';

function literalValue(e: Expr): { ok: true; value: Value } | { ok: false } {
  switch (e.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return { ok: true, value: e.value };
    case 'unary':
      if (e.op === '-' && e.operand.kind === 'num') return { ok: true, value: -e.operand.value };
      if (e.op === '+' && e.operand.kind === 'num') return { ok: true, value: e.operand.value };
      return { ok: false };
    case 'vector': {
      const out: Value[] = [];
      for (const item of e.items) {
        if (!isExpr(item)) return { ok: false };
        const v = literalValue(item);
        if (!v.ok || typeof v.value !== 'number') return { ok: false };
        out.push(v.value);
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false };
  }
}

function decimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function stepFor(...nums: number[]): number {
  const d = Math.max(0, ...nums.map(decimals));
  return d === 0 ? 1 : Math.pow(10, -Math.min(d, 6));
}

function tryLiteral(text: string): Value | undefined {
  try {
    const v = literalValue(parseExpression(text));
    return v.ok ? v.value : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the widget spec in a trailing comment, e.g. "[0:10]", "[a, b]", "[1:Small, 2:Large]". */
function parseWidget(spec: string | undefined, value: Value): CustomizerWidget {
  const type = typeof value;
  const m = spec ? /^\s*\[(.*)\]\s*$/.exec(spec) : null;
  if (m) {
    const inner = m[1].trim();
    // range: [max], [min:max], [min:step:max]
    const range = /^(-?[\d.]+(?:e-?\d+)?)(?:\s*:\s*(-?[\d.]+(?:e-?\d+)?))?(?:\s*:\s*(-?[\d.]+(?:e-?\d+)?))?$/i.exec(inner);
    if (range && (type === 'number' || Array.isArray(value))) {
      const nums = [range[1], range[2], range[3]].filter((x) => x !== undefined).map(Number);
      let min = 0, max: number, step: number | undefined;
      if (nums.length === 1) max = nums[0];
      else if (nums.length === 2) [min, max] = nums;
      else [min, step, max] = nums;
      step ??= stepFor(min, max, ...(typeof value === 'number' ? [value] : []));
      if (Array.isArray(value)) return { kind: 'vector', length: value.length, min, max, step };
      return { kind: 'slider', min, max, step };
    }
    // dropdown
    const options: { value: Value; label: string }[] = [];
    for (const part of splitTopLevel(inner)) {
      const p = part.trim();
      if (!p) continue;
      const colon = p.indexOf(':');
      let rawVal = p, label = p;
      if (colon >= 0) {
        rawVal = p.slice(0, colon).trim();
        label = p.slice(colon + 1).trim();
      }
      let v: Value;
      if (type === 'number') {
        const num = Number(rawVal);
        v = Number.isNaN(num) ? rawVal : num;
      } else v = rawVal.replace(/^"(.*)"$/, '$1');
      if (colon < 0) label = String(v);
      options.push({ value: v, label });
    }
    if (options.length) return { kind: 'dropdown', options };
  } else if (spec !== undefined) {
    const n = Number(spec.trim());
    if (spec.trim() && !Number.isNaN(n)) {
      if (type === 'string') return { kind: 'text', maxLength: n };
      if (type === 'number') return { kind: 'spinbox', step: n > 0 ? n : stepFor(value as number) };
    }
  }
  if (type === 'boolean') return { kind: 'checkbox' };
  if (type === 'string') return { kind: 'text' };
  if (Array.isArray(value)) return { kind: 'vector', length: value.length, step: stepFor(...(value as number[])) };
  return { kind: 'spinbox', step: stepFor(value as number) };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', inStr = false;
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Extract customizer parameters from OpenSCAD source following the conventions
 * of OpenSCAD's customizer. Returns an empty list on syntax errors.
 */
export function extractParameters(source: string): CustomizerParameter[] {
  return parseParameters(source) ?? [];
}

/**
 * Like {@link extractParameters} but returns `null` on syntax errors, so callers
 * can keep the previous parameter set (and user overrides) while code is being edited.
 */
export function parseParameters(source: string): CustomizerParameter[] | null {
  let program, comments: Comment[];
  try {
    ({ program, comments } = parse(source));
  } catch {
    return null;
  }
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (pos: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const params: CustomizerParameter[] = [];
  const seen = new Map<string, number>();
  for (const stmt of program.body) {
    if (stmt.kind === 'module') break; // customizer stops at the first module definition
    if (stmt.kind !== 'assign') continue;
    const a = stmt as Assignment;
    if (a.name.startsWith('$')) continue; // special variables are not parameters
    const lit = literalValue(a.value);
    if (!lit.ok) continue;
    const line = lineAt(a.pos);

    // group: last "/* [Name] */" before the assignment
    let group = DEFAULT_GROUP;
    let description: string | undefined;
    let trailing: string | undefined;
    for (const c of comments) {
      if (c.start >= a.pos) {
        // trailing comment on the same line after the statement
        if (c.kind === 'line' && lineAt(c.start) === line && c.start >= a.end && trailing === undefined) trailing = c.text;
        if (c.start > a.end + 1 && lineAt(c.start) > line) break;
        continue;
      }
      if (c.kind === 'block') {
        const g = /^\s*\[([^\]]+)\]\s*$/.exec(c.text);
        if (g) group = g[1].trim();
      }
    }
    // description: line comment(s) on the line(s) directly above
    const desc: string[] = [];
    let expectLine = line - 1;
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (c.start >= a.pos) continue;
      if (c.kind !== 'line') break;
      const cl = lineAt(c.start);
      if (cl > expectLine) continue;
      if (cl !== expectLine) break;
      // must be the only thing on its line
      if (source.slice(lineStarts[cl - 1], c.start).trim() !== '') break;
      desc.unshift(c.text.trim());
      expectLine--;
    }
    if (desc.length) description = desc.join(' ');
    if (group.toLowerCase() === 'hidden') continue;

    const value = lit.value;
    const type = typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : 'vector';
    let widget = parseWidget(trailing, value);
    if (type === 'vector' && (value as Value[]).length > 4) continue; // OpenSCAD supports up to 4
    if (widget.kind === 'dropdown' && type === 'boolean') widget = { kind: 'checkbox' };
    const p: CustomizerParameter = { name: a.name, group, description, type, initial: value, widget, line };
    const prev = seen.get(a.name);
    if (prev !== undefined) params[prev] = p;
    else {
      seen.set(a.name, params.length);
      params.push(p);
    }
  }
  return params;
}

/** Group parameters by tab, preserving source order. "Global" parameters appear in every tab. */
export function groupParameters(params: CustomizerParameter[]): CustomizerGroup[] {
  const groups = new Map<string, CustomizerParameter[]>();
  const global = params.filter((p) => p.group.toLowerCase() === 'global');
  for (const p of params) {
    if (p.group.toLowerCase() === 'global') continue;
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group)!.push(p);
  }
  const out = [...groups].map(([name, ps]) => ({ name, parameters: [...ps, ...global] }));
  if (!out.length && global.length) out.push({ name: 'Global', parameters: global });
  return out;
}

/** Serialize parameter values as an OpenSCAD JSON parameter set (customizer presets). */
export function toParameterSet(name: string, values: Record<string, Value>): object {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) set[k] = typeof v === 'string' ? v : valueToString(v);
  return { parameterSets: { [name]: set }, fileFormatVersion: '1' };
}

/** Parse values from an OpenSCAD JSON parameter set. */
export function fromParameterSet(json: unknown, params: CustomizerParameter[]): Record<string, Record<string, Value>> {
  const out: Record<string, Record<string, Value>> = {};
  const sets = (json as { parameterSets?: Record<string, Record<string, string>> })?.parameterSets ?? {};
  for (const [setName, set] of Object.entries(sets)) {
    const vals: Record<string, Value> = {};
    for (const p of params) {
      if (!(p.name in set)) continue;
      const raw = set[p.name];
      if (p.type === 'string') vals[p.name] = raw;
      else {
        const v = tryLiteral(String(raw));
        if (v !== undefined) vals[p.name] = v;
      }
    }
    out[setName] = vals;
  }
  return out;
}
