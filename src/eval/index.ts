export * from './values';
export * from './csg-tree';
export { Scope } from './scope';
export { Interpreter, EvalError, group } from './interpreter';
export type { EvalOptions, EvalResult, EvalFileSystem, FileLookup, Message, MessageLevel, PendingFile } from './interpreter';
export { BUILTIN_FUNCTIONS } from './builtin-functions';
export { BUILTIN_MODULES } from './builtin-modules';
export { parseColorString, COLOR_NAMES } from './colors';

import { parse } from '../lang/parser';
import { Interpreter, EvalOptions, EvalResult } from './interpreter';
import { SyntaxError } from '../lang/lexer';

/** Parse and evaluate OpenSCAD source in one step. */
export function evaluate(source: string, options: EvalOptions = {}, file?: string): EvalResult {
  let program;
  try {
    program = parse(source, file).program;
  } catch (e) {
    const err = e as SyntaxError;
    return {
      nodes: [],
      messages: [{ level: 'error', text: `Parser error: ${err.message}`, file: err.file, pos: err.pos }],
      pending: [],
      failed: true,
    };
  }
  return new Interpreter(options).run(program);
}
