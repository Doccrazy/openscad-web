import type { Font } from 'opentype.js';
import type { TextNode } from '../eval/csg-tree';

/** Synchronous font lookup used during geometry evaluation. */
export interface FontProvider {
  /** Return a parsed font for an OpenSCAD font spec like "Liberation Sans:style=Bold". */
  getFont(spec: string): Font | undefined;
}

export interface ParsedFontSpec {
  family: string;
  bold: boolean;
  italic: boolean;
}

export function parseFontSpec(spec: string): ParsedFontSpec {
  const [family, ...rest] = spec.split(':');
  let style = '';
  for (const r of rest) {
    const m = /^\s*style\s*=\s*(.*)$/i.exec(r);
    if (m) style = m[1].toLowerCase();
  }
  return {
    family: family.trim(),
    bold: /bold|black|heavy|semibold/.test(style),
    italic: /italic|oblique/.test(style),
  };
}

type Contour = [number, number][];

/** Flatten an opentype path into closed polygon contours (y up). */
function pathToContours(commands: { type: string; [k: string]: number | string }[], segments: number): Contour[] {
  const out: Contour[] = [];
  let cur: Contour = [];
  let x0 = 0, y0 = 0;
  const push = (x: number, y: number): void => {
    const last = cur[cur.length - 1];
    if (!last || last[0] !== x || last[1] !== -y) cur.push([x, -y]);
  };
  for (const c of commands) {
    const n = (k: string): number => c[k] as number;
    switch (c.type) {
      case 'M':
        if (cur.length > 2) out.push(cur);
        cur = [];
        x0 = n('x'); y0 = n('y');
        push(x0, y0);
        break;
      case 'L':
        x0 = n('x'); y0 = n('y');
        push(x0, y0);
        break;
      case 'Q':
        for (let i = 1; i <= segments; i++) {
          const t = i / segments, u = 1 - t;
          push(u * u * x0 + 2 * u * t * n('x1') + t * t * n('x'), u * u * y0 + 2 * u * t * n('y1') + t * t * n('y'));
        }
        x0 = n('x'); y0 = n('y');
        break;
      case 'C':
        for (let i = 1; i <= segments; i++) {
          const t = i / segments, u = 1 - t;
          push(
            u * u * u * x0 + 3 * u * u * t * n('x1') + 3 * u * t * t * n('x2') + t * t * t * n('x'),
            u * u * u * y0 + 3 * u * u * t * n('y1') + 3 * u * t * t * n('y2') + t * t * t * n('y'),
          );
        }
        x0 = n('x'); y0 = n('y');
        break;
      case 'Z':
        if (cur.length > 2) {
          const f = cur[0], l = cur[cur.length - 1];
          if (f[0] === l[0] && f[1] === l[1]) cur.pop();
          out.push(cur);
        }
        cur = [];
        break;
    }
  }
  if (cur.length > 2) out.push(cur);
  return out;
}

/** Convert a text() node into polygon contours (to be filled with the NonZero rule). */
export function textToContours(node: TextNode, font: Font): Contour[] {
  const size = node.size;
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(node.text);
  const rtl = node.direction === 'rtl';
  const vertical = node.direction === 'ttb' || node.direction === 'btt';
  const ordered = rtl ? [...glyphs].reverse() : glyphs;
  const contours: Contour[] = [];
  let pen = 0;
  const lineHeight = size * 1.2;
  ordered.forEach((g, i) => {
    let ox = pen, oy = 0;
    if (vertical) {
      ox = -((g.advanceWidth ?? 0) * scale) / 2;
      oy = node.direction === 'ttb' ? -i * lineHeight : i * lineHeight;
    }
    const path = g.getPath(ox, oy, size);
    contours.push(...pathToContours(path.commands as never, node.segments));
    if (!vertical) {
      let adv = (g.advanceWidth ?? 0) * scale;
      const next = ordered[i + 1];
      if (next) adv += font.getKerningValue(g, next) * scale;
      pen += adv * node.spacing;
    }
  });
  if (!contours.length) return contours;
  // alignment
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of contours) for (const [x, y] of c) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const width = vertical ? maxX - minX : pen;
  let dx = 0, dy = 0;
  switch (node.halign) {
    case 'center': dx = vertical ? -(minX + maxX) / 2 : -width / 2; break;
    case 'right': dx = vertical ? -maxX : -width; break;
    default: dx = vertical ? -minX : 0;
  }
  switch (node.valign) {
    case 'top': dy = -maxY; break;
    case 'center': dy = -(minY + maxY) / 2; break;
    case 'bottom': dy = -minY; break;
    default: dy = 0;
  }
  if (dx || dy) for (const c of contours) for (const p of c) { p[0] += dx; p[1] += dy; }
  return contours;
}
