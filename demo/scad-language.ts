import { StreamLanguage, LanguageSupport, StringStream } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { BUILTIN_FUNCTIONS, BUILTIN_MODULES, KEYWORDS } from '../src';

const builtins = new Set([...Object.keys(BUILTIN_FUNCTIONS), ...Object.keys(BUILTIN_MODULES)]);
const constants = new Set(['PI', 'true', 'false', 'undef']);

interface State {
  inComment: boolean;
}

/** Simple stream-based OpenSCAD syntax highlighting for CodeMirror 6. */
export const scadLanguage = StreamLanguage.define<State>({
  name: 'openscad',
  startState: () => ({ inComment: false }),
  token(stream: StringStream, state: State): string | null {
    if (state.inComment) {
      if (stream.skipTo('*/')) {
        stream.next();
        stream.next();
        state.inComment = false;
      } else stream.skipToEnd();
      return 'blockComment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'lineComment';
    }
    if (stream.match('/*')) {
      state.inComment = true;
      return 'blockComment';
    }
    if (stream.match(/^(include|use)\s*<[^>]*>/)) return 'meta';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)) return 'number';
    if (stream.match(/^\$[a-zA-Z_]\w*/)) return 'special';
    const id = stream.match(/^[a-zA-Z_]\w*/) as RegExpMatchArray | null;
    if (id) {
      const w = id[0];
      if (constants.has(w)) return 'atom';
      if (KEYWORDS.has(w)) return 'keyword';
      if (builtins.has(w)) return 'builtin';
      return 'variableName';
    }
    if (stream.match(/^[!#%*](?=\s*[a-zA-Z_{])/)) return 'modifier';
    if (stream.match(/^[-+*/%^<>=!&|?:]+/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
  tokenTable: {
    special: tags.special(tags.variableName),
    builtin: tags.standard(tags.variableName),
    modifier: tags.modifier,
  },
});

const SNIPPETS: Record<string, string> = {
  cube: 'cube(size, center=false)',
  sphere: 'sphere(r)',
  cylinder: 'cylinder(h, r1, r2, center=false)',
  polyhedron: 'polyhedron(points, faces)',
  square: 'square(size, center=false)',
  circle: 'circle(r)',
  polygon: 'polygon(points, paths)',
  text: 'text(text, size=10, font, halign, valign)',
  translate: 'translate([x, y, z])',
  rotate: 'rotate([x, y, z])',
  scale: 'scale([x, y, z])',
  mirror: 'mirror([x, y, z])',
  color: 'color(c, alpha)',
  linear_extrude: 'linear_extrude(height, center, twist, slices, scale)',
  rotate_extrude: 'rotate_extrude(angle=360)',
  offset: 'offset(r | delta, chamfer)',
};

function completions(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\$?\w*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const doc = ctx.state.doc.toString();
  const user = new Set<string>();
  for (const m of doc.matchAll(/\b(?:module|function)\s+([a-zA-Z_]\w*)/g)) user.add(m[1]);
  for (const m of doc.matchAll(/^\s*([a-zA-Z_$]\w*)\s*=/gm)) user.add(m[1]);
  const options = [
    ...Object.keys(BUILTIN_MODULES).map((l) => ({ label: l, type: 'class', detail: SNIPPETS[l] ? SNIPPETS[l].slice(l.length) : '' })),
    ...Object.keys(BUILTIN_FUNCTIONS).map((l) => ({ label: l, type: 'function' })),
    ...[...KEYWORDS].map((l) => ({ label: l, type: 'keyword' })),
    ...['$fn', '$fa', '$fs', '$t', '$preview', '$children', 'PI'].map((l) => ({ label: l, type: 'constant' })),
    ...[...user].map((l) => ({ label: l, type: 'variable' })),
  ];
  return { from: word.from, options, validFor: /^\$?\w*$/ };
}

export function openscad(): LanguageSupport {
  return new LanguageSupport(scadLanguage, [scadLanguage.data.of({ autocomplete: completions })]);
}
