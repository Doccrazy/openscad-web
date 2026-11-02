import type { FunctionDefinition, ModuleDefinition, Statement } from '../lang/ast';
import type { Value } from './values';

export interface UserModule {
  def: ModuleDefinition;
  scope: Scope;
}

export interface UserFunction {
  def: FunctionDefinition;
  scope: Scope;
}

/** Children passed to a module invocation, evaluated lazily in the caller scope. */
export interface ChildrenRef {
  statements: Statement[];
  scope: Scope;
}

/**
 * A lexical scope. Regular variables are resolved lexically through `parent`.
 * Special `$` variables are resolved dynamically: a scope created for a module
 * or function call has `dynParent` pointing at the calling scope.
 */
export class Scope {
  readonly vars = new Map<string, Value>();
  functions?: Map<string, UserFunction>;
  modules?: Map<string, UserModule>;
  /** Children for `children()` within a module body. */
  children?: ChildrenRef;
  /** Name of the module this scope belongs to (for parent_module). */
  moduleName?: string;
  /** Library scopes imported with `use <...>`; only functions / modules are visible. */
  uses?: Scope[];

  constructor(
    readonly parent?: Scope,
    readonly dynParent?: Scope,
  ) {}

  child(): Scope {
    return new Scope(this);
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }

  set(name: string, v: Value): void {
    this.vars.set(name, v);
  }

  /** Lookup a variable. Returns [found, value]. */
  lookup(name: string): Value {
    if (name.charCodeAt(0) === 36 /* $ */) {
      let s: Scope | undefined = this;
      while (s) {
        if (s.vars.has(name)) return s.vars.get(name);
        s = s.dynParent ?? s.parent;
      }
      return undefined;
    }
    let s: Scope | undefined = this;
    while (s) {
      if (s.vars.has(name)) return s.vars.get(name);
      s = s.parent;
    }
    return undefined;
  }

  isDefined(name: string): boolean {
    let s: Scope | undefined = this;
    const special = name.charCodeAt(0) === 36;
    while (s) {
      if (s.vars.has(name)) return true;
      s = special ? (s.dynParent ?? s.parent) : s.parent;
    }
    return false;
  }

  lookupFunction(name: string): UserFunction | undefined {
    let s: Scope | undefined = this;
    while (s) {
      const f = s.functions?.get(name);
      if (f) return f;
      if (s.uses) {
        for (let i = s.uses.length - 1; i >= 0; i--) {
          const u = s.uses[i].functions?.get(name);
          if (u) return u;
        }
      }
      s = s.parent;
    }
    return undefined;
  }

  lookupModule(name: string): UserModule | undefined {
    let s: Scope | undefined = this;
    while (s) {
      const f = s.modules?.get(name);
      if (f) return f;
      if (s.uses) {
        for (let i = s.uses.length - 1; i >= 0; i--) {
          const u = s.uses[i].modules?.get(name);
          if (u) return u;
        }
      }
      s = s.parent;
    }
    return undefined;
  }

  /** Find the closest enclosing children reference (dynamic). */
  lookupChildren(): ChildrenRef | undefined {
    let s: Scope | undefined = this;
    while (s) {
      if (s.children) return s.children;
      s = s.parent;
    }
    return undefined;
  }

  defineFunction(name: string, f: UserFunction): void {
    (this.functions ??= new Map()).set(name, f);
  }

  defineModule(name: string, m: UserModule): void {
    (this.modules ??= new Map()).set(name, m);
  }
}
