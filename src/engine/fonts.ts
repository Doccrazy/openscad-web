import { parse as parseFont } from 'opentype.js';
import type { Font } from 'opentype.js';
import { FontProvider, parseFontSpec } from '../geometry/text';

export interface FontSource {
  /** Family name used for matching, e.g. "Liberation Sans". */
  family: string;
  bold?: boolean;
  italic?: boolean;
  /** URL to fetch or raw font data (TTF/OTF/WOFF). */
  source: string | ArrayBuffer;
}

/**
 * Holds parsed fonts and resolves OpenSCAD font specs. Unknown families fall
 * back to the first registered family (OpenSCAD's default is Liberation Sans).
 */
export class FontRegistry implements FontProvider {
  private fonts: { family: string; bold: boolean; italic: boolean; font: Font }[] = [];
  private pending: FontSource[] = [];
  private loading: Promise<void> | undefined;

  constructor(sources: FontSource[] = []) {
    this.pending.push(...sources);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  add(src: FontSource): void {
    this.pending.push(src);
  }

  /** Load all registered font sources. */
  load(): Promise<void> {
    if (!this.pending.length) return this.loading ?? Promise.resolve();
    const batch = this.pending.splice(0);
    const prev = this.loading ?? Promise.resolve();
    this.loading = prev.then(() =>
      Promise.all(
        batch.map(async (s) => {
          try {
            const buf = typeof s.source === 'string' ? await (await fetch(s.source)).arrayBuffer() : s.source;
            const font = parseFont(buf);
            this.fonts.push({ family: s.family.toLowerCase(), bold: !!s.bold, italic: !!s.italic, font });
          } catch (e) {
            console.warn(`Failed to load font ${s.family}:`, e);
          }
        }),
      ).then(() => undefined),
    );
    return this.loading;
  }

  getFont(spec: string): Font | undefined {
    if (!this.fonts.length) return undefined;
    const want = parseFontSpec(spec || 'Liberation Sans');
    const fam = want.family.toLowerCase();
    let candidates = this.fonts.filter((f) => f.family === fam);
    if (!candidates.length) candidates = this.fonts.filter((f) => f.family === this.fonts[0].family);
    const score = (f: { bold: boolean; italic: boolean }): number =>
      (f.bold === want.bold ? 2 : 0) + (f.italic === want.italic ? 1 : 0);
    return candidates.reduce((a, b) => (score(b) > score(a) ? b : a)).font;
  }
}
