import type {
  Argument,
  Assignment,
  Expr,
  Loc,
  ModuleInstantiation,
  Parameter,
  Program,
  Statement,
  VectorElement,
} from '../lang/ast';
import { SyntaxError } from '../lang/lexer';
import { isExpr, parse } from '../lang/parser';
import { BUILTIN_FUNCTIONS, FnArgs, FnContext } from './builtin-functions';
import { BUILTIN_MODULES, ModuleCall } from './builtin-modules';
import type { GeomNode } from './csg-tree';
import { ChildrenRef, Scope } from './scope';
import {
  FunctionValue,
  ObjectValue,
  RangeValue,
  Value,
  add,
  compare,
  div,
  iterateValue,
  mod,
  mul,
  neg,
  pow,
  sub,
  truthy,
  valueToString,
  valuesEqual,
} from './values';

export type MessageLevel = 'echo' | 'warning' | 'error' | 'info';

export interface Message {
  level: MessageLevel;
  text: string;
  file?: string;
  pos?: number;
  end?: number;
}

/** Result of a synchronous file lookup. `'pending'` requests an async load + re-run. */
export type FileLookup<T> = { path: string; data: T } | 'pending' | undefined;

/**
 * Synchronous file access used during evaluation. Implementations typically
 * serve from a cache and return `'pending'` for files that must be fetched
 * asynchronously; the engine then loads them and re-evaluates.
 */
export interface EvalFileSystem {
  readText(path: string, relativeTo?: string): FileLookup<string>;
  readBinary(path: string, relativeTo?: string): FileLookup<Uint8Array>;
}

export interface PendingFile {
  path: string;
  relativeTo?: string;
  binary: boolean;
}

export interface EvalOptions {
  /** Values overriding top-level assignments of the main file (customizer). */
  overrides?: Record<string, Value>;
  fs?: EvalFileSystem;
  /** Abort evaluation after this many milliseconds (default: no limit). */
  timeoutMs?: number;
  /** Extra special variables, e.g. `$t` for animation. */
  specialVars?: Record<string, Value>;
  /** Maximum number of geometry nodes before aborting (default 2,000,000). */
  maxNodes?: number;
}

export interface EvalResult {
  /** Top-level geometry nodes (implicitly unioned). */
  nodes: GeomNode[];
  messages: Message[];
  /** Files that must be loaded before a re-evaluation can succeed. */
  pending: PendingFile[];
  /** True if evaluation aborted due to an error. */
  failed: boolean;
}

export class EvalError extends Error {
  constructor(
    message: string,
    public readonly loc?: Loc,
  ) {
    super(message);
    this.name = 'EvalError';
  }
}

const MAX_RECURSION = 2000;

/** Marker used to implement tail call elimination for user functions. */
interface PendingCall {
  fn: { params: Parameter[]; body: Expr; scope: Scope; name: string };
  args: FnArgs;
  caller: Scope;
}

/**
 * Tree-walking interpreter for OpenSCAD programs producing a {@link GeomNode} tree.
 */
export class Interpreter {
  readonly messages: Message[] = [];
  readonly pending: PendingFile[] = [];
  private readonly global: Scope;
  private depth = 0;
  private deadline = Infinity;
  private steps = 0;
  private rootNode: GeomNode | undefined;
  private libraries = new Map<string, Scope>();
  private parseCache = new Map<string, Program | null>();
  private nodeCount = 0;
  private readonly maxNodes: number;

  constructor(private readonly options: EvalOptions = {}) {
    this.global = new Scope();
    const g = this.global.vars;
    g.set('PI', Math.PI);
    g.set('$fn', 0);
    g.set('$fa', 12);
    g.set('$fs', 2);
    g.set('$t', 0);
    g.set('$preview', true);
    g.set('$vpr', [55, 0, 25]);
    g.set('$vpt', [0, 0, 0]);
    g.set('$vpd', 140);
    g.set('$vpf', 22.5);
    g.set('$children', 0);
    g.set('$parent_modules', 0);
    for (const [k, v] of Object.entries(options.specialVars ?? {})) g.set(k, v);
    this.maxNodes = options.maxNodes ?? 2_000_000;
  }

  // -- public API ------------------------------------------------------------------

  run(program: Program): EvalResult {
    this.deadline = this.options.timeoutMs ? Date.now() + this.options.timeoutMs : Infinity;
    const scope = new Scope(this.global);
    scope.moduleName = '';
    let nodes: GeomNode[] = [];
    let failed = false;
    try {
      nodes = this.evalBlock(program.body, scope, this.options.overrides, program.file);
    } catch (e) {
      failed = true;
      this.reportError(e);
    }
    if (this.rootNode) nodes = [this.rootNode];
    return { nodes, messages: this.messages, pending: this.pending, failed };
  }

  /** Evaluate a standalone expression in the global scope. */
  evaluateExpression(e: Expr): Value {
    return this.evalExpr(e, new Scope(this.global));
  }

  warn(text: string, loc?: Loc): void {
    this.messages.push({ level: 'warning', text, file: loc?.file, pos: loc?.pos, end: loc?.end });
  }

  private reportError(e: unknown): void {
    if (e instanceof EvalError) {
      this.messages.push({ level: 'error', text: e.message, file: e.loc?.file, pos: e.loc?.pos, end: e.loc?.end });
    } else if (e instanceof SyntaxError) {
      this.messages.push({ level: 'error', text: `Parser error: ${e.message}`, file: e.file, pos: e.pos });
    } else if (e instanceof RangeError) {
      this.messages.push({ level: 'error', text: `Recursion too deep (${e.message})` });
    } else {
      this.messages.push({ level: 'error', text: String((e as Error)?.message ?? e) });
    }
  }

  private tick(loc?: Loc): void {
    if ((++this.steps & 0x3fff) === 0 && Date.now() > this.deadline)
      throw new EvalError('Evaluation timed out', loc);
  }

  // -- files -----------------------------------------------------------------------

  private loadProgram(path: string, relativeTo: string | undefined, loc: Loc): Program | undefined {
    const fs = this.options.fs;
    if (!fs) {
      this.warn(`Can't open file '${path}' (no file system available)`, loc);
      return undefined;
    }
    const r = fs.readText(path, relativeTo);
    if (r === 'pending') {
      this.pending.push({ path, relativeTo, binary: false });
      return undefined;
    }
    if (!r) {
      this.warn(`Can't open library '${path}'`, loc);
      return undefined;
    }
    let cached = this.parseCache.get(r.path);
    if (cached === undefined) {
      try {
        cached = parse(r.data, r.path).program;
      } catch (e) {
        this.reportError(e);
        cached = null;
      }
      this.parseCache.set(r.path, cached);
    }
    return cached ?? undefined;
  }

  /** Load a binary or text file for import()/surface(). */
  readFile(path: string, relativeTo: string | undefined, binary: boolean, loc: Loc): { path: string; data: Uint8Array | string } | undefined {
    const fs = this.options.fs;
    if (!fs) {
      this.warn(`Can't open file '${path}' (no file system available)`, loc);
      return undefined;
    }
    const r = binary ? fs.readBinary(path, relativeTo) : fs.readText(path, relativeTo);
    if (r === 'pending') {
      this.pending.push({ path, relativeTo, binary });
      return undefined;
    }
    if (!r) this.warn(`Can't open file '${path}'`, loc);
    return r;
  }

  // -- blocks & statements ------------------------------------------------------------

  /** Expand `include <...>` statements inline. */
  private expandIncludes(stmts: Statement[], depth = 0): Statement[] {
    if (!stmts.some((s) => s.kind === 'include')) return stmts;
    const out: Statement[] = [];
    for (const s of stmts) {
      if (s.kind === 'include') {
        if (depth > 50) throw new EvalError('Include nesting too deep', s);
        const prog = this.loadProgram(s.path, s.file, s);
        if (prog) out.push(...this.expandIncludes(prog.body, depth + 1));
      } else out.push(s);
    }
    return out;
  }

  private useLibrary(path: string, scope: Scope, loc: Loc): void {
    const prog = this.loadProgram(path, loc.file, loc);
    if (!prog || !prog.file) return;
    let lib = this.libraries.get(prog.file);
    if (!lib) {
      lib = new Scope(this.global);
      this.libraries.set(prog.file, lib);
      // only definitions and assignments matter for a used library
      const stmts = this.expandIncludes(prog.body).filter(
        (s) => s.kind === 'assign' || s.kind === 'module' || s.kind === 'function' || s.kind === 'use',
      );
      this.evalBlock(stmts, lib);
    }
    (scope.uses ??= []).push(lib);
  }

  /**
   * Prepare a block: hoist definitions, evaluate assignments (OpenSCAD semantics:
   * a re-assigned variable keeps the position of its first assignment but the
   * value of the last), and return the statements that produce geometry.
   */
  private prepareBlock(
    body: Statement[],
    scope: Scope,
    overrides?: Record<string, Value>,
  ): Statement[] {
    const stmts = this.expandIncludes(body);
    const assigns: Assignment[] = [];
    const index = new Map<string, number>();
    const rest: Statement[] = [];
    for (const s of stmts) {
      switch (s.kind) {
        case 'module':
          scope.defineModule(s.name, { def: s, scope });
          break;
        case 'function':
          scope.defineFunction(s.name, { def: s, scope });
          break;
        case 'use':
          this.useLibrary(s.path, scope, s);
          break;
        case 'assign': {
          const i = index.get(s.name);
          if (i !== undefined) {
            if (scope !== this.global && !overrides)
              this.warn(`'${s.name}' was assigned more than once; the last assignment wins`, s);
            assigns[i] = s;
          } else {
            index.set(s.name, assigns.length);
            assigns.push(s);
          }
          break;
        }
        default:
          rest.push(s);
      }
    }
    for (const a of assigns) {
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, a.name)) {
        scope.set(a.name, overrides[a.name]);
      } else {
        scope.set(a.name, this.evalExpr(a.value, scope));
      }
    }
    return rest;
  }

  evalBlock(body: Statement[], scope: Scope, overrides?: Record<string, Value>, _file?: string): GeomNode[] {
    const rest = this.prepareBlock(body, scope, overrides);
    const out: GeomNode[] = [];
    for (const s of rest) {
      const n = this.instantiate(s, scope);
      if (n) out.push(n);
    }
    return out;
  }

  /** Evaluate child statements in a new scope and return their nodes. */
  evalChildBlock(body: Statement[], scope: Scope): GeomNode[] {
    if (body.length === 0) return [];
    return this.evalBlock(body, new Scope(scope));
  }

  private instantiate(s: Statement, scope: Scope): GeomNode | undefined {
    this.tick(s);
    let mods: { root?: boolean; highlight?: boolean; background?: boolean; disable?: boolean } = {};
    let node: GeomNode | undefined;
    switch (s.kind) {
      case 'if': {
        mods = s.modifiers;
        if (mods.disable) return undefined;
        const c = truthy(this.evalExpr(s.cond, scope));
        const branch = c ? s.then : s.else;
        node = branch ? group(this.evalChildBlock(branch, scope), s) : undefined;
        break;
      }
      case 'block':
        mods = s.modifiers;
        if (mods.disable) return undefined;
        node = group(this.evalChildBlock(s.body, scope), s);
        break;
      case 'instantiate':
        mods = s.modifiers;
        if (mods.disable) return undefined;
        node = this.callModule(s, scope);
        break;
      default:
        return undefined;
    }
    if (!node) return undefined;
    if (mods.background) node = { type: 'modifier', mode: 'background', children: [node], src: node.src };
    else if (mods.highlight) node = { type: 'modifier', mode: 'highlight', children: [node], src: node.src };
    if (mods.root && !this.rootNode) this.rootNode = node;
    return node;
  }

  /** Evaluate arguments of a call. Special `$` named args are returned separately. */
  evalArgs(args: Argument[], scope: Scope): FnArgs {
    const positional: Value[] = [];
    const named = new Map<string, Value>();
    for (const a of args) {
      const v = this.evalExpr(a.value, scope);
      if (a.name !== undefined) named.set(a.name, v);
      else positional.push(v);
    }
    return { positional, named };
  }

  private callModule(s: ModuleInstantiation, scope: Scope): GeomNode | undefined {
    const user = scope.lookupModule(s.name);
    if (user) {
      if (this.depth > MAX_RECURSION) throw new EvalError(`Recursion detected calling module '${s.name}'`, s);
      const args = this.evalArgs(s.args, scope);
      const callScope = new Scope(user.scope, scope);
      callScope.moduleName = s.name;
      this.bindParams(user.def.params, args, callScope, s);
      const nChildren = s.children.filter((c) => c.kind === 'instantiate' || c.kind === 'if' || c.kind === 'block').length;
      callScope.set('$children', nChildren);
      callScope.set('$parent_modules', depthOfModules(scope) + 1);
      callScope.children = { statements: s.children, scope };
      this.depth++;
      try {
        const nodes = this.evalBlock(user.def.body, callScope);
        return group(nodes, s);
      } finally {
        this.depth--;
      }
    }
    const builtin = BUILTIN_MODULES[s.name];
    if (builtin) {
      const callScope = new Scope(scope);
      const call: ModuleCall = {
        interp: this,
        stmt: s,
        scope: callScope,
        args: s.args,
        evalArgs: () => {
          const a = this.evalArgs(s.args, scope);
          for (const [k, v] of a.named) if (k.startsWith('$')) callScope.set(k, v);
          return a;
        },
        children: () => this.evalChildBlock(s.children, callScope),
      };
      const n = builtin(call);
      if (n) {
        n.src ??= { file: s.file, pos: s.pos, end: s.end };
        if (++this.nodeCount > this.maxNodes) throw new EvalError('Too many objects', s);
      }
      return n;
    }
    this.warn(`Ignoring unknown module '${s.name}'`, s);
    return undefined;
  }

  /** Evaluate `children(...)` from within a module body. */
  evalChildren(scope: Scope, indices: number[] | undefined, loc: Loc): GeomNode[] {
    const ref: ChildrenRef | undefined = scope.lookupChildren();
    if (!ref) return [];
    const s = new Scope(ref.scope, scope);
    const stmts = this.prepareBlock(ref.statements, s);
    const chosen: Statement[] = [];
    if (indices) {
      for (const i of indices) {
        if (i >= 0 && i < stmts.length && Number.isInteger(i)) chosen.push(stmts[i]);
        else this.warn(`Children index (${i}) out of bounds (${stmts.length} children)`, loc);
      }
    } else chosen.push(...stmts);
    const out: GeomNode[] = [];
    // children are evaluated with the caller's module depth
    for (const st of chosen) {
      const n = this.instantiate(st, s);
      if (n) out.push(n);
    }
    return out;
  }

  private bindParams(params: Parameter[], args: FnArgs, scope: Scope, loc: Loc): void {
    const { positional, named } = args;
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (named.has(p.name)) scope.set(p.name, named.get(p.name));
      else if (i < positional.length) scope.set(p.name, positional[i]);
      else if (p.default) scope.set(p.name, this.evalExpr(p.default, scope));
      else scope.set(p.name, undefined);
    }
    for (const [k, v] of named) {
      if (k.startsWith('$')) scope.set(k, v);
      else if (!params.some((p) => p.name === k)) this.warn(`Ignoring unknown variable '${k}'`, loc);
    }
  }

  // -- expressions -------------------------------------------------------------------

  evalExpr(e: Expr, scope: Scope): Value {
    switch (e.kind) {
      case 'num':
        return e.value;
      case 'str':
        return e.value;
      case 'bool':
        return e.value;
      case 'undef':
        return undefined;
      case 'ident': {
        const v = scope.lookup(e.name);
        if (v === undefined && !scope.isDefined(e.name)) {
          this.warn(`Ignoring unknown variable '${e.name}'`, e);
        }
        return v;
      }
      case 'vector': {
        const out: Value[] = [];
        for (const item of e.items) {
          if (isExpr(item)) out.push(this.evalExpr(item, scope));
          else this.evalLc(item, scope, out);
        }
        return out;
      }
      case 'range': {
        const start = this.evalExpr(e.from, scope);
        const step = e.step ? this.evalExpr(e.step, scope) : 1;
        const end = this.evalExpr(e.to, scope);
        if (typeof start !== 'number' || typeof step !== 'number' || typeof end !== 'number') return undefined;
        if (!e.step && end < start) {
          this.warn('DEPRECATED: Using ranges of the form [begin:end] with begin value greater than the end value is deprecated', e);
          return new RangeValue(end, 1, start);
        }
        return new RangeValue(start, step, end);
      }
      case 'unary': {
        const v = this.evalExpr(e.operand, scope);
        if (e.op === '!') return !truthy(v);
        if (e.op === '-') return neg(v);
        return typeof v === 'number' || Array.isArray(v) ? v : undefined;
      }
      case 'binary':
        return this.evalBinary(e.op, e.left, e.right, scope);
      case 'ternary':
        return truthy(this.evalExpr(e.cond, scope)) ? this.evalExpr(e.then, scope) : this.evalExpr(e.else, scope);
      case 'index': {
        const o = this.evalExpr(e.object, scope);
        const i = this.evalExpr(e.index, scope);
        return indexValue(o, i);
      }
      case 'member': {
        const o = this.evalExpr(e.object, scope);
        if (o instanceof ObjectValue) return o.entries.get(e.name);
        if (Array.isArray(o)) {
          const idx = 'xyz'.indexOf(e.name);
          if (idx >= 0 && e.name.length === 1) return o[idx];
        }
        if (o instanceof RangeValue) {
          if (e.name === 'begin') return o.start;
          if (e.name === 'step') return o.step;
          if (e.name === 'end') return o.end;
        }
        return undefined;
      }
      case 'let': {
        const s = new Scope(scope);
        for (const a of e.assignments) s.set(a.name, this.evalExpr(a.value, s));
        return this.evalExpr(e.body, s);
      }
      case 'assert':
        this.doAssert(e.args, scope, e);
        return e.body ? this.evalExpr(e.body, scope) : undefined;
      case 'echo':
        this.doEcho(e.args, scope, e);
        return e.body ? this.evalExpr(e.body, scope) : undefined;
      case 'funclit':
        return new FunctionValue(e.params, e.body, scope);
      case 'call':
        return this.evalCall(e, scope);
    }
  }

  private evalBinary(op: string, l: Expr, r: Expr, scope: Scope): Value {
    if (op === '&&') return truthy(this.evalExpr(l, scope)) && truthy(this.evalExpr(r, scope));
    if (op === '||') return truthy(this.evalExpr(l, scope)) || truthy(this.evalExpr(r, scope));
    const a = this.evalExpr(l, scope);
    const b = this.evalExpr(r, scope);
    switch (op) {
      case '+': return add(a, b);
      case '-': return sub(a, b);
      case '*': return mul(a, b);
      case '/': return div(a, b);
      case '%': return mod(a, b);
      case '^': return pow(a, b);
      case '==': return valuesEqual(a, b);
      case '!=': return !valuesEqual(a, b);
      case '<': case '<=': case '>': case '>=':
        return compare(op, a, b);
    }
    return undefined;
  }

  doEcho(args: Argument[], scope: Scope, loc: Loc): void {
    const parts: string[] = [];
    for (const a of args) {
      const v = this.evalExpr(a.value, scope);
      parts.push(a.name !== undefined ? `${a.name} = ${valueToString(v, true)}` : valueToString(v, true));
    }
    this.messages.push({ level: 'echo', text: parts.join(', '), file: loc.file, pos: loc.pos, end: loc.end });
  }

  doAssert(args: Argument[], scope: Scope, loc: Loc): void {
    const a = this.evalArgs(args, scope);
    const cond = a.named.has('condition') ? a.named.get('condition') : a.positional[0];
    if (!truthy(cond)) {
      const msg = a.named.has('message') ? a.named.get('message') : a.positional[1];
      const condText = args[0] ? exprSource(args[0].value) : '';
      throw new EvalError(
        `Assertion '${condText}' failed${msg !== undefined ? `: ${valueToString(msg, true)}` : ''}`,
        loc,
      );
    }
  }

  private evalLc(el: VectorElement, scope: Scope, out: Value[]): void {
    if (isExpr(el)) {
      out.push(this.evalExpr(el, scope));
      return;
    }
    switch (el.kind) {
      case 'lc-each': {
        if (isExpr(el.body)) {
          const v = this.evalExpr(el.body, scope);
          if (Array.isArray(v) || v instanceof RangeValue || typeof v === 'string') for (const x of iterateValue(v)) out.push(x);
          else out.push(v);
        } else {
          const tmp: Value[] = [];
          this.evalLc(el.body, scope, tmp);
          for (const v of tmp) {
            if (Array.isArray(v) || v instanceof RangeValue) for (const x of iterateValue(v)) out.push(x);
            else out.push(v);
          }
        }
        return;
      }
      case 'lc-if': {
        if (truthy(this.evalExpr(el.cond, scope))) this.evalLc(el.then, scope, out);
        else if (el.else) this.evalLc(el.else, scope, out);
        return;
      }
      case 'lc-let': {
        const s = new Scope(scope);
        for (const a of el.assignments) s.set(a.name, this.evalExpr(a.value, s));
        this.evalLc(el.body, s, out);
        return;
      }
      case 'lc-for': {
        this.forEachAssignment(el.assignments, scope, (s) => this.evalLc(el.body, s, out), el);
        return;
      }
      case 'lc-forc': {
        let s = new Scope(scope);
        for (const a of el.init) s.set(a.name, this.evalExpr(a.value, s));
        let guard = 0;
        while (truthy(this.evalExpr(el.cond, s))) {
          if (++guard > 10_000_000) throw new EvalError('For loop counter exceeded limit', el);
          this.tick(el);
          this.evalLc(el.body, s, out);
          const next = new Scope(scope);
          for (const a of el.update) next.set(a.name, this.evalExpr(a.value, s));
          // carry over vars not updated
          for (const [k, v] of s.vars) if (!next.vars.has(k)) next.set(k, v);
          s = next;
        }
        return;
      }
    }
  }

  /** Iterate over the cartesian product of for-loop assignments. */
  forEachAssignment(
    assigns: { name: string; value: Expr }[] | { name: string; value: Value }[],
    scope: Scope,
    cb: (s: Scope) => void,
    loc: Loc,
    evaluated = false,
  ): void {
    const rec = (i: number, s: Scope): void => {
      if (i >= assigns.length) {
        cb(s);
        return;
      }
      const a = assigns[i];
      const v = evaluated ? (a.value as Value) : this.evalExpr(a.value as Expr, s);
      if (v instanceof RangeValue && v.count > 10_000_000) throw new EvalError('Range too large', loc);
      for (const x of iterateValue(v)) {
        this.tick(loc);
        const ns = new Scope(s);
        ns.set(a.name, x);
        rec(i + 1, ns);
      }
    };
    rec(0, scope);
  }

  private evalCall(e: Extract<Expr, { kind: 'call' }>, scope: Scope): Value {
    this.tick(e);
    if (e.callee.kind === 'ident') {
      const name = e.callee.name;
      const uf = scope.lookupFunction(name);
      if (uf) {
        const args = this.evalArgs(e.args, scope);
        return this.callFunction({ params: uf.def.params, body: uf.def.body, scope: uf.scope, name }, args, scope, e);
      }
      const v = scope.lookup(name);
      if (v instanceof FunctionValue) {
        const args = this.evalArgs(e.args, scope);
        return this.callFunction({ params: v.params, body: v.body, scope: v.scope, name }, args, scope, e);
      }
      const bf = BUILTIN_FUNCTIONS[name];
      if (bf) {
        const args = this.evalArgs(e.args, scope);
        return bf(args, this.fnContext(scope, e));
      }
      this.warn(`Ignoring unknown function '${name}'`, e);
      return undefined;
    }
    const callee = this.evalExpr(e.callee, scope);
    if (callee instanceof FunctionValue) {
      const args = this.evalArgs(e.args, scope);
      return this.callFunction({ params: callee.params, body: callee.body, scope: callee.scope, name: '' }, args, scope, e);
    }
    this.warn('Called object is not a function', e);
    return undefined;
  }

  private fnContext(scope: Scope, loc: Loc): FnContext {
    return {
      warn: (m) => this.warn(m, loc),
      parentModule: (n) => {
        const names: string[] = [];
        let s: Scope | undefined = scope;
        while (s) {
          if (s.moduleName) names.push(s.moduleName);
          s = s.dynParent ?? s.parent;
        }
        return names[n - 1];
      },
    };
  }

  /** Call a user function with tail-call elimination. */
  private callFunction(fn: PendingCall['fn'], args: FnArgs, caller: Scope, loc: Loc): Value {
    if (this.depth > MAX_RECURSION) throw new EvalError(`Recursion detected calling function '${fn.name}'`, loc);
    this.depth++;
    try {
      let cur: PendingCall | undefined = { fn, args, caller };
      while (cur) {
        const s = new Scope(cur.fn.scope, cur.caller);
        this.bindParams(cur.fn.params, cur.args, s, loc);
        const r = this.evalTail(cur.fn.body, s);
        if (r instanceof TailCall) cur = r.call;
        else return r;
        this.tick(loc);
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  /** Evaluate an expression in tail position; calls to user functions are returned as TailCall. */
  private evalTail(e: Expr, scope: Scope): Value | TailCall {
    for (;;) {
      switch (e.kind) {
        case 'ternary':
          e = truthy(this.evalExpr(e.cond, scope)) ? e.then : e.else;
          continue;
        case 'let': {
          const s = new Scope(scope);
          for (const a of e.assignments) s.set(a.name, this.evalExpr(a.value, s));
          scope = s;
          e = e.body;
          continue;
        }
        case 'assert':
          this.doAssert(e.args, scope, e);
          if (!e.body) return undefined;
          e = e.body;
          continue;
        case 'echo':
          this.doEcho(e.args, scope, e);
          if (!e.body) return undefined;
          e = e.body;
          continue;
        case 'call': {
          if (e.callee.kind === 'ident') {
            const name = e.callee.name;
            const uf = scope.lookupFunction(name);
            if (uf) {
              return new TailCall({
                fn: { params: uf.def.params, body: uf.def.body, scope: uf.scope, name },
                args: this.evalArgs(e.args, scope),
                caller: scope,
              });
            }
            const v = scope.lookup(name);
            if (v instanceof FunctionValue) {
              return new TailCall({
                fn: { params: v.params, body: v.body, scope: v.scope, name },
                args: this.evalArgs(e.args, scope),
                caller: scope,
              });
            }
          }
          return this.evalExpr(e, scope);
        }
        default:
          return this.evalExpr(e, scope);
      }
    }
  }
}

class TailCall {
  constructor(readonly call: PendingCall) {}
}

function depthOfModules(scope: Scope): number {
  let n = 0;
  let s: Scope | undefined = scope;
  while (s) {
    if (s.moduleName) n++;
    s = s.dynParent ?? s.parent;
  }
  return n;
}

export function indexValue(o: Value, i: Value): Value {
  if (typeof i !== 'number' || Number.isNaN(i)) {
    if (o instanceof ObjectValue && typeof i === 'string') return o.entries.get(i);
    return undefined;
  }
  const idx = Math.floor(i);
  if (Array.isArray(o)) return o[idx];
  if (typeof o === 'string') {
    // fast path for ASCII
    if (/^[\x00-\x7f]*$/.test(o)) return idx >= 0 && idx < o.length ? o[idx] : undefined;
    return Array.from(o)[idx];
  }
  if (o instanceof RangeValue) {
    if (idx === 0) return o.start;
    if (idx === 1) return o.step;
    if (idx === 2) return o.end;
  }
  return undefined;
}

/** Wrap a list of nodes into a group, collapsing trivial groups. */
export function group(nodes: GeomNode[], loc?: Loc): GeomNode | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return { type: 'group', children: nodes, src: loc ? { file: loc.file, pos: loc.pos, end: loc.end } : undefined };
}

/** Best-effort pretty-print of an expression (used for assertion messages). */
export function exprSource(e: Expr): string {
  switch (e.kind) {
    case 'num': return valueToString(e.value);
    case 'str': return JSON.stringify(e.value);
    case 'bool': return String(e.value);
    case 'undef': return 'undef';
    case 'ident': return e.name;
    case 'unary': return e.op + exprSource(e.operand);
    case 'binary': return `(${exprSource(e.left)} ${e.op} ${exprSource(e.right)})`;
    case 'ternary': return `(${exprSource(e.cond)} ? ${exprSource(e.then)} : ${exprSource(e.else)})`;
    case 'call': return `${exprSource(e.callee)}(${e.args.map((a) => (a.name ? a.name + ' = ' : '') + exprSource(a.value)).join(', ')})`;
    case 'index': return `${exprSource(e.object)}[${exprSource(e.index)}]`;
    case 'member': return `${exprSource(e.object)}.${e.name}`;
    case 'vector': return `[${e.items.map((i) => (isExpr(i) ? exprSource(i) : '...')).join(', ')}]`;
    case 'range': return `[${exprSource(e.from)} : ${e.step ? exprSource(e.step) + ' : ' : ''}${exprSource(e.to)}]`;
    default: return '...';
  }
}
