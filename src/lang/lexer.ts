/**
 * Tokenizer for the OpenSCAD language.
 *
 * Comments are not emitted as tokens but are collected separately so that
 * tooling such as the customizer can inspect them.
 */

export type TokenType =
  | 'number'
  | 'string'
  | 'ident'
  | 'keyword'
  | 'op'
  | 'include'
  | 'use'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  /** Numeric value for number tokens. */
  num?: number;
  start: number;
  end: number;
  /** True if a newline occurred between the previous token and this one. */
  newlineBefore: boolean;
}

export interface Comment {
  text: string;
  /** 'line' for `// ...`, 'block' for `/* ... *\/`. */
  kind: 'line' | 'block';
  start: number;
  end: number;
}

export const KEYWORDS = new Set([
  'module',
  'function',
  'if',
  'else',
  'for',
  'let',
  'each',
  'true',
  'false',
  'undef',
  'assert',
  'echo',
]);

const OPERATORS = [
  '<=', '>=', '==', '!=', '&&', '||',
  '+', '-', '*', '/', '%', '^', '!', '<', '>', '=', '?', ':', ',', ';', '.',
  '(', ')', '[', ']', '{', '}', '#',
];

export class SyntaxError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
    public readonly file?: string,
  ) {
    super(message);
    this.name = 'SyntaxError';
  }
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
}

export function tokenize(src: string, file?: string): LexResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  const n = src.length;
  let newline = false;

  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      if (c === '\n') newline = true;
      i++;
      continue;
    }
    // comments
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      comments.push({ text: src.slice(start + 2, i), kind: 'line', start, end: i });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new SyntaxError('Unterminated block comment', start, file);
      i = close + 2;
      const text = src.slice(start + 2, close);
      if (text.includes('\n')) newline = true;
      comments.push({ text, kind: 'block', start, end: i });
      continue;
    }

    const start = i;

    // include <...> / use <...>
    if (c === 'i' || c === 'u') {
      const m = /^(include|use)\s*<([^>]*)>/.exec(src.slice(i, i + 1024));
      if (m && (i === 0 || !isIdentPart(src[i - 1]))) {
        i += m[0].length;
        tokens.push({
          type: m[1] as 'include' | 'use',
          value: m[2].trim(),
          start,
          end: i,
          newlineBefore: newline,
        });
        newline = false;
        continue;
      }
    }

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && /[0-9a-fA-F]/.test(src[i + 2] ?? '')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < n && isDigit(src[i])) i++;
        if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
          i++;
          while (i < n && isDigit(src[i])) i++;
        } else if (src[i] === '.' && !isIdentStart(src[i + 1] ?? '')) {
          // "1." is a valid number
          i++;
        }
        if (src[i] === 'e' || src[i] === 'E') {
          let j = i + 1;
          if (src[j] === '+' || src[j] === '-') j++;
          if (isDigit(src[j] ?? '')) {
            i = j;
            while (i < n && isDigit(src[i])) i++;
          }
        }
      }
      const text = src.slice(start, i);
      tokens.push({ type: 'number', value: text, num: Number(text), start, end: i, newlineBefore: newline });
      newline = false;
      continue;
    }

    // identifiers & keywords
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(src[i])) i++;
      const text = src.slice(start, i);
      tokens.push({
        type: KEYWORDS.has(text) ? 'keyword' : 'ident',
        value: text,
        start,
        end: i,
        newlineBefore: newline,
      });
      newline = false;
      continue;
    }

    // strings
    if (c === '"') {
      i++;
      let out = '';
      for (;;) {
        if (i >= n) throw new SyntaxError('Unterminated string', start, file);
        const ch = src[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\') {
          const e = src[i + 1];
          i += 2;
          switch (e) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case '\\': out += '\\'; break;
            case '"': out += '"'; break;
            case 'x': {
              const hex = src.slice(i, i + 2);
              if (/^[0-7][0-9a-fA-F]$/.test(hex)) {
                const code = parseInt(hex, 16);
                if (code > 0) out += String.fromCharCode(code);
                i += 2;
              } else out += '\\x';
              break;
            }
            case 'u':
            case 'U': {
              const len = e === 'u' ? 4 : 6;
              const hex = src.slice(i, i + len);
              if (new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) {
                const code = parseInt(hex, 16);
                if (code > 0 && code <= 0x10ffff) out += String.fromCodePoint(code);
                i += len;
              } else out += '\\' + e;
              break;
            }
            case '\n':
              break;
            default:
              out += '\\' + (e ?? '');
          }
          continue;
        }
        out += ch;
        i++;
      }
      tokens.push({ type: 'string', value: out, start, end: i, newlineBefore: newline });
      newline = false;
      continue;
    }

    // operators
    let matched: string | undefined;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      i += matched.length;
      tokens.push({ type: 'op', value: matched, start, end: i, newlineBefore: newline });
      newline = false;
      continue;
    }

    throw new SyntaxError(`Unexpected character '${c}'`, i, file);
  }
  tokens.push({ type: 'eof', value: '', start: n, end: n, newlineBefore: newline });
  return { tokens, comments };
}

/** Convert a character offset into a 1-based line / column pair. */
export function offsetToLineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lastNl = -1;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, col: offset - lastNl };
}
