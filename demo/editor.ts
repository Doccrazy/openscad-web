import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { setDiagnostics, Diagnostic, lintGutter } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { openscad } from './scad-language';

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--tok-keyword)' },
  { tag: t.standard(t.variableName), color: 'var(--tok-builtin)' },
  { tag: t.special(t.variableName), color: 'var(--tok-special)' },
  { tag: t.number, color: 'var(--tok-number)' },
  { tag: t.string, color: 'var(--tok-string)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--tok-atom)' },
  { tag: t.modifier, color: 'var(--tok-modifier)', fontWeight: 'bold' },
  { tag: t.meta, color: 'var(--tok-meta)' },
  { tag: t.operator, color: 'var(--muted)' },
]);

export interface EditorMessage {
  level: 'error' | 'warning' | 'echo' | 'info';
  text: string;
  pos?: number;
  end?: number;
}

export class CodeEditor {
  readonly view: EditorView;
  private readonly readOnly = new Compartment();

  constructor(parent: HTMLElement, doc: string, onChange: (code: string) => void, keys: { key: string; run: () => boolean }[]) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          keymap.of([...keys.map((k) => ({ key: k.key, run: k.run, preventDefault: true })), indentWithTab]),
          openscad(),
          syntaxHighlighting(highlight),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          lintGutter(),
          this.readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
  }

  get code(): string {
    return this.view.state.doc.toString();
  }

  setCode(code: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: code } });
  }

  setMessages(messages: EditorMessage[]): void {
    const len = this.view.state.doc.length;
    const diags: Diagnostic[] = [];
    for (const m of messages) {
      if (m.pos === undefined || (m.level !== 'error' && m.level !== 'warning')) continue;
      const from = Math.min(m.pos, len);
      const to = Math.min(Math.max(m.end ?? from, from + 1), len);
      diags.push({ from, to: Math.max(from, to), severity: m.level, message: m.text });
    }
    this.view.dispatch(setDiagnostics(this.view.state, diags));
  }

  goto(pos: number): void {
    const p = Math.min(pos, this.view.state.doc.length);
    this.view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
    this.view.focus();
  }
}
