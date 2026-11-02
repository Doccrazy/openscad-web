import type {
  Argument,
  Assignment,
  BinaryOp,
  Expr,
  Modifiers,
  Parameter,
  Program,
  Statement,
  VectorElement,
} from './ast';
import { Comment, SyntaxError, Token, tokenize } from './lexer';

export interface ParseResult {
  program: Program;
  comments: Comment[];
}

/** Parse OpenSCAD source code into an AST. Throws {@link SyntaxError} on failure. */
export function parse(source: string, file?: string): ParseResult {
  const { tokens, comments } = tokenize(source, file);
  const p = new Parser(tokens, file);
  const body = p.parseStatements(true);
  return { program: { file, source, body }, comments };
}

/** Parse a single expression (used for customizer values etc.). */
export function parseExpression(source: string): Expr {
  const { tokens } = tokenize(source);
  const p = new Parser(tokens);
  const e = p.parseExpr();
  p.expectEof();
  return e;
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly file?: string,
  ) {}

  // -- helpers ---------------------------------------------------------------

  private get tok(): Token {
    return this.tokens[this.i];
  }

  private peek(k = 1): Token {
    return this.tokens[Math.min(this.i + k, this.tokens.length - 1)];
  }

  private isOp(v: string, t: Token = this.tok): boolean {
    return t.type === 'op' && t.value === v;
  }

  private isKw(v: string, t: Token = this.tok): boolean {
    return t.type === 'keyword' && t.value === v;
  }

  private next(): Token {
    const t = this.tokens[this.i];
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private error(msg: string, t: Token = this.tok): never {
    throw new SyntaxError(msg, t.start, this.file);
  }

  private describe(t: Token): string {
    return t.type === 'eof' ? 'end of file' : `'${t.value}'`;
  }

  private expectOp(v: string): Token {
    if (!this.isOp(v)) this.error(`Expected '${v}' but found ${this.describe(this.tok)}`);
    return this.next();
  }

  private expectIdent(): Token {
    if (this.tok.type !== 'ident') this.error(`Expected identifier but found ${this.describe(this.tok)}`);
    return this.next();
  }

  expectEof(): void {
    if (this.tok.type !== 'eof') this.error(`Unexpected ${this.describe(this.tok)}`);
  }

  private prevEnd(): number {
    return this.tokens[Math.max(0, this.i - 1)].end;
  }

  // -- statements --------------------------------------------------------------

  parseStatements(topLevel: boolean): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      if (this.tok.type === 'eof') {
        if (!topLevel) this.error("Expected '}' but found end of file");
        return out;
      }
      if (!topLevel && this.isOp('}')) return out;
      const s = this.parseStatement();
      if (s) out.push(s);
    }
  }

  private parseStatement(): Statement | undefined {
    const t = this.tok;
    if (this.isOp(';')) {
      this.next();
      return undefined;
    }
    if (t.type === 'include' || t.type === 'use') {
      this.next();
      return { kind: t.type, path: t.value, pos: t.start, end: t.end, file: this.file };
    }
    if (this.isOp('{')) {
      this.next();
      const body = this.parseStatements(false);
      this.expectOp('}');
      return { kind: 'block', body, modifiers: {}, pos: t.start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('module')) return this.parseModuleDef();
    if (this.isKw('function')) return this.parseFunctionDef();
    if (t.type === 'ident' && this.isOp('=', this.peek())) {
      const a = this.parseAssignment();
      this.expectOp(';');
      return a;
    }
    return this.parseInstantiation();
  }

  private parseAssignment(): Assignment {
    const name = this.expectIdent();
    this.expectOp('=');
    const value = this.parseExpr();
    return { kind: 'assign', name: name.value, value, pos: name.start, end: this.prevEnd(), file: this.file };
  }

  private parseModuleDef(): Statement {
    const start = this.next().start;
    const name = this.expectIdent().value;
    this.expectOp('(');
    const params = this.parseParams();
    this.expectOp(')');
    const body = this.parseChildStatements();
    return { kind: 'module', name, params, body, pos: start, end: this.prevEnd(), file: this.file };
  }

  private parseFunctionDef(): Statement {
    const start = this.next().start;
    const name = this.expectIdent().value;
    this.expectOp('(');
    const params = this.parseParams();
    this.expectOp(')');
    this.expectOp('=');
    const body = this.parseExpr();
    this.expectOp(';');
    return { kind: 'function', name, params, body, pos: start, end: this.prevEnd(), file: this.file };
  }

  private parseParams(): Parameter[] {
    const params: Parameter[] = [];
    while (!this.isOp(')')) {
      const name = this.expectIdent();
      let def: Expr | undefined;
      if (this.isOp('=')) {
        this.next();
        def = this.parseExpr();
      }
      params.push({ name: name.value, default: def, pos: name.start, end: this.prevEnd(), file: this.file });
      if (!this.isOp(',')) break;
      this.next();
    }
    return params;
  }

  /** Statement(s) following a module instantiation / definition header. */
  private parseChildStatements(): Statement[] {
    if (this.isOp(';')) {
      this.next();
      return [];
    }
    if (this.isOp('{')) {
      this.next();
      const body = this.parseStatements(false);
      this.expectOp('}');
      return body;
    }
    const s = this.parseInstantiation();
    return s ? [s] : [];
  }

  private parseInstantiation(): Statement | undefined {
    const start = this.tok.start;
    const modifiers: Modifiers = {};
    for (;;) {
      if (this.isOp('!')) modifiers.root = true;
      else if (this.isOp('#')) modifiers.highlight = true;
      else if (this.isOp('%')) modifiers.background = true;
      else if (this.isOp('*')) modifiers.disable = true;
      else break;
      this.next();
    }
    const t = this.tok;
    if (this.isKw('if')) {
      this.next();
      this.expectOp('(');
      const cond = this.parseExpr();
      this.expectOp(')');
      const then = this.parseChildStatements();
      let els: Statement[] | undefined;
      if (this.isKw('else')) {
        this.next();
        els = this.parseChildStatements();
      }
      return { kind: 'if', cond, then, else: els, modifiers, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isOp('{') && Object.keys(modifiers).length) {
      this.next();
      const body = this.parseStatements(false);
      this.expectOp('}');
      return { kind: 'block', body, modifiers, pos: start, end: this.prevEnd(), file: this.file };
    }
    let name: string;
    if (t.type === 'ident') name = t.value;
    else if (this.isKw('for') || this.isKw('let') || this.isKw('echo') || this.isKw('assert') || this.isKw('each'))
      name = t.value;
    else this.error(`Unexpected ${this.describe(t)}`);
    this.next();
    this.expectOp('(');
    const args = this.parseArgs();
    this.expectOp(')');
    const children = this.parseChildStatements();
    return {
      kind: 'instantiate',
      name,
      args,
      children,
      modifiers,
      pos: start,
      end: this.prevEnd(),
      file: this.file,
    };
  }

  private parseArgs(): Argument[] {
    const args: Argument[] = [];
    while (!this.isOp(')')) {
      const start = this.tok.start;
      let name: string | undefined;
      if (this.tok.type === 'ident' && this.isOp('=', this.peek())) {
        name = this.next().value;
        this.next();
      }
      const value = this.parseExpr();
      args.push({ name, value, pos: start, end: this.prevEnd(), file: this.file });
      if (!this.isOp(',')) break;
      this.next();
    }
    return args;
  }

  private parseAssignmentList(): Assignment[] {
    const out: Assignment[] = [];
    while (!this.isOp(')') && !this.isOp(';')) {
      out.push(this.parseAssignment());
      if (!this.isOp(',')) break;
      this.next();
    }
    return out;
  }

  // -- expressions -------------------------------------------------------------

  parseExpr(): Expr {
    const t = this.tok;
    const start = t.start;
    if (this.isKw('function') && this.isOp('(', this.peek())) {
      this.next();
      this.expectOp('(');
      const params = this.parseParams();
      this.expectOp(')');
      const body = this.parseExpr();
      return { kind: 'funclit', params, body, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('let')) {
      this.next();
      this.expectOp('(');
      const assignments = this.parseAssignmentList();
      this.expectOp(')');
      const body = this.parseExpr();
      return { kind: 'let', assignments, body, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('assert') || this.isKw('echo')) {
      const kind = this.next().value as 'assert' | 'echo';
      this.expectOp('(');
      const args = this.parseArgs();
      this.expectOp(')');
      let body: Expr | undefined;
      if (this.startsExpr()) body = this.parseExpr();
      return { kind, args, body, pos: start, end: this.prevEnd(), file: this.file };
    }
    const cond = this.parseBinary(0);
    if (this.isOp('?')) {
      this.next();
      const then = this.parseExpr();
      this.expectOp(':');
      const els = this.parseExpr();
      return { kind: 'ternary', cond, then, else: els, pos: start, end: this.prevEnd(), file: this.file };
    }
    return cond;
  }

  private startsExpr(): boolean {
    const t = this.tok;
    if (t.type === 'number' || t.type === 'string' || t.type === 'ident') return true;
    if (t.type === 'keyword')
      return ['true', 'false', 'undef', 'let', 'assert', 'echo', 'function'].includes(t.value);
    if (t.type === 'op') return ['(', '[', '-', '+', '!'].includes(t.value);
    return false;
  }

  private static readonly LEVELS: string[][] = [
    ['||'],
    ['&&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private parseBinary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    const ops = Parser.LEVELS[level];
    let left = this.parseBinary(level + 1);
    while (this.tok.type === 'op' && ops.includes(this.tok.value)) {
      const op = this.next().value as BinaryOp;
      const right = this.parseBinary(level + 1);
      left = { kind: 'binary', op, left, right, pos: left.pos, end: this.prevEnd(), file: this.file };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('-') || this.isOp('+') || this.isOp('!')) {
      const t = this.next();
      const operand = this.parseUnary();
      return {
        kind: 'unary',
        op: t.value as '-' | '+' | '!',
        operand,
        pos: t.start,
        end: this.prevEnd(),
        file: this.file,
      };
    }
    return this.parseExponent();
  }

  private parseExponent(): Expr {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      const exp = this.parseUnary();
      return { kind: 'binary', op: '^', left: base, right: exp, pos: base.pos, end: this.prevEnd(), file: this.file };
    }
    return base;
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('(')) {
        this.next();
        const args = this.parseArgs();
        this.expectOp(')');
        e = { kind: 'call', callee: e, args, pos: e.pos, end: this.prevEnd(), file: this.file };
      } else if (this.isOp('[')) {
        this.next();
        const index = this.parseExpr();
        this.expectOp(']');
        e = { kind: 'index', object: e, index, pos: e.pos, end: this.prevEnd(), file: this.file };
      } else if (this.isOp('.') && this.peek().type === 'ident') {
        this.next();
        const name = this.next().value;
        e = { kind: 'member', object: e, name, pos: e.pos, end: this.prevEnd(), file: this.file };
      } else return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.tok;
    const loc = { pos: t.start, end: t.end, file: this.file };
    switch (t.type) {
      case 'number':
        this.next();
        return { kind: 'num', value: t.num!, ...loc };
      case 'string':
        this.next();
        return { kind: 'str', value: t.value, ...loc };
      case 'ident':
        this.next();
        return { kind: 'ident', name: t.value, ...loc };
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') {
          this.next();
          return { kind: 'bool', value: t.value === 'true', ...loc };
        }
        if (t.value === 'undef') {
          this.next();
          return { kind: 'undef', ...loc };
        }
        if (['let', 'assert', 'echo', 'function'].includes(t.value)) return this.parseExpr();
        break;
      case 'op':
        if (t.value === '(') {
          this.next();
          const e = this.parseExpr();
          this.expectOp(')');
          return e;
        }
        if (t.value === '[') return this.parseVector();
        break;
    }
    this.error(`Unexpected ${this.describe(t)}`);
  }

  private parseVector(): Expr {
    const start = this.expectOp('[').start;
    if (this.isOp(']')) {
      this.next();
      return { kind: 'vector', items: [], pos: start, end: this.prevEnd(), file: this.file };
    }
    const first = this.parseElement();
    if (this.isOp(':') && isExpr(first)) {
      this.next();
      const second = this.parseExpr();
      if (this.isOp(':')) {
        this.next();
        const third = this.parseExpr();
        this.expectOp(']');
        return { kind: 'range', from: first, step: second, to: third, pos: start, end: this.prevEnd(), file: this.file };
      }
      this.expectOp(']');
      return { kind: 'range', from: first, to: second, pos: start, end: this.prevEnd(), file: this.file };
    }
    const items: VectorElement[] = [first];
    while (this.isOp(',')) {
      this.next();
      if (this.isOp(']')) break;
      items.push(this.parseElement());
    }
    this.expectOp(']');
    return { kind: 'vector', items, pos: start, end: this.prevEnd(), file: this.file };
  }

  private parseElement(): VectorElement {
    const t = this.tok;
    const start = t.start;
    if (this.isKw('for')) {
      this.next();
      this.expectOp('(');
      const init = this.parseAssignmentList();
      if (this.isOp(';')) {
        this.next();
        const cond = this.parseExpr();
        this.expectOp(';');
        const update = this.parseAssignmentList();
        this.expectOp(')');
        const body = this.parseElement();
        return { kind: 'lc-forc', init, cond, update, body, pos: start, end: this.prevEnd(), file: this.file };
      }
      this.expectOp(')');
      const body = this.parseElement();
      return { kind: 'lc-for', assignments: init, body, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('each')) {
      this.next();
      const body = this.parseElement();
      return { kind: 'lc-each', body, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('if')) {
      this.next();
      this.expectOp('(');
      const cond = this.parseExpr();
      this.expectOp(')');
      const then = this.parseElement();
      let els: VectorElement | undefined;
      if (this.isKw('else')) {
        this.next();
        els = this.parseElement();
      }
      return { kind: 'lc-if', cond, then, else: els, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isKw('let')) {
      this.next();
      this.expectOp('(');
      const assignments = this.parseAssignmentList();
      this.expectOp(')');
      const body = this.parseElement();
      return { kind: 'lc-let', assignments, body, pos: start, end: this.prevEnd(), file: this.file };
    }
    if (this.isOp('(') && this.isLcKeyword(this.peek())) {
      this.next();
      const e = this.parseElement();
      this.expectOp(')');
      return e;
    }
    return this.parseExpr();
  }

  private isLcKeyword(t: Token): boolean {
    return t.type === 'keyword' && (t.value === 'for' || t.value === 'each' || t.value === 'if');
  }
}

export function isExpr(e: VectorElement): e is Expr {
  return !e.kind.startsWith('lc-');
}
