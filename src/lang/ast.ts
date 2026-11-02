/** AST definitions for the OpenSCAD language. All nodes carry a source offset. */

export interface Loc {
  /** Start offset into the source. */
  pos: number;
  /** End offset into the source. */
  end: number;
  /** Source file identifier (path or URI); undefined for the main file. */
  file?: string;
}

// ---------------------------------------------------------------------------
// Expressions

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | UndefLit
  | Identifier
  | VectorExpr
  | RangeExpr
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | CallExpr
  | IndexExpr
  | MemberExpr
  | LetExpr
  | AssertExpr
  | EchoExpr
  | FunctionLiteral;

export interface NumberLit extends Loc { kind: 'num'; value: number }
export interface StringLit extends Loc { kind: 'str'; value: string }
export interface BoolLit extends Loc { kind: 'bool'; value: boolean }
export interface UndefLit extends Loc { kind: 'undef' }
export interface Identifier extends Loc { kind: 'ident'; name: string }
export interface VectorExpr extends Loc { kind: 'vector'; items: VectorElement[] }
export interface RangeExpr extends Loc { kind: 'range'; from: Expr; step?: Expr; to: Expr }
export interface UnaryExpr extends Loc { kind: 'unary'; op: '-' | '+' | '!'; operand: Expr }
export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | '&&' | '||';
export interface BinaryExpr extends Loc { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
export interface TernaryExpr extends Loc { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
export interface CallExpr extends Loc { kind: 'call'; callee: Expr; args: Argument[] }
export interface IndexExpr extends Loc { kind: 'index'; object: Expr; index: Expr }
export interface MemberExpr extends Loc { kind: 'member'; object: Expr; name: string }
export interface LetExpr extends Loc { kind: 'let'; assignments: Assignment[]; body: Expr }
export interface AssertExpr extends Loc { kind: 'assert'; args: Argument[]; body?: Expr }
export interface EchoExpr extends Loc { kind: 'echo'; args: Argument[]; body?: Expr }
export interface FunctionLiteral extends Loc { kind: 'funclit'; params: Parameter[]; body: Expr }

/** Elements allowed inside `[ ... ]`, including list comprehension parts. */
export type VectorElement = Expr | LcFor | LcForC | LcIf | LcEach | LcLet;

export interface LcFor extends Loc { kind: 'lc-for'; assignments: Assignment[]; body: VectorElement }
export interface LcForC extends Loc {
  kind: 'lc-forc';
  init: Assignment[];
  cond: Expr;
  update: Assignment[];
  body: VectorElement;
}
export interface LcIf extends Loc { kind: 'lc-if'; cond: Expr; then: VectorElement; else?: VectorElement }
export interface LcEach extends Loc { kind: 'lc-each'; body: VectorElement }
export interface LcLet extends Loc { kind: 'lc-let'; assignments: Assignment[]; body: VectorElement }

export interface Argument extends Loc {
  name?: string;
  value: Expr;
}

export interface Parameter extends Loc {
  name: string;
  default?: Expr;
}

// ---------------------------------------------------------------------------
// Statements

export type Statement =
  | Assignment
  | ModuleInstantiation
  | IfStatement
  | ModuleDefinition
  | FunctionDefinition
  | IncludeStatement
  | UseStatement
  | BlockStatement;

export interface Assignment extends Loc { kind: 'assign'; name: string; value: Expr }

export interface Modifiers {
  /** `!` – only render this subtree. */
  root?: boolean;
  /** `#` – highlight (render in CSG and additionally as transparent overlay). */
  highlight?: boolean;
  /** `%` – background (excluded from CSG, rendered transparent). */
  background?: boolean;
  /** `*` – disable. */
  disable?: boolean;
}

export interface ModuleInstantiation extends Loc {
  kind: 'instantiate';
  name: string;
  args: Argument[];
  children: Statement[];
  modifiers: Modifiers;
}

export interface IfStatement extends Loc {
  kind: 'if';
  cond: Expr;
  then: Statement[];
  else?: Statement[];
  modifiers: Modifiers;
}

export interface BlockStatement extends Loc { kind: 'block'; body: Statement[]; modifiers: Modifiers }

export interface ModuleDefinition extends Loc {
  kind: 'module';
  name: string;
  params: Parameter[];
  body: Statement[];
}

export interface FunctionDefinition extends Loc {
  kind: 'function';
  name: string;
  params: Parameter[];
  body: Expr;
}

export interface IncludeStatement extends Loc { kind: 'include'; path: string }
export interface UseStatement extends Loc { kind: 'use'; path: string }

export interface Program {
  file?: string;
  source: string;
  body: Statement[];
}
