import { describe, expect, it } from 'vitest';
import { extractParameters, groupParameters } from '../src/customizer';

describe('customizer', () => {
  it('extracts parameters with widgets, groups and descriptions', () => {
    const src = `
/* [Size] */
// Width of the box
width = 20; // [10:100]
height = 5.5; // [1:0.5:20]
// Shape
shape = "round"; // [round, square, "hex"]
quality = 2; // [1:Low, 2:Medium, 3:High]
/* [Options] */
hollow = true;
size = [1, 2, 3]; // [0:10]
label = "hi"; // 8
derived = width * 2;
/* [Hidden] */
secret = 1;
module m() {}
after = 3;
`;
    const ps = extractParameters(src);
    expect(ps.map((p) => p.name)).toEqual(['width', 'height', 'shape', 'quality', 'hollow', 'size', 'label']);
    expect(ps[0]).toMatchObject({ group: 'Size', description: 'Width of the box', widget: { kind: 'slider', min: 10, max: 100, step: 1 } });
    expect(ps[1].widget).toEqual({ kind: 'slider', min: 1, max: 20, step: 0.5 });
    expect(ps[2].widget).toMatchObject({ kind: 'dropdown', options: [{ value: 'round' }, { value: 'square' }, { value: 'hex' }] });
    expect(ps[3].widget).toMatchObject({ kind: 'dropdown', options: [{ value: 1, label: 'Low' }, { value: 2, label: 'Medium' }, { value: 3, label: 'High' }] });
    expect(ps[4]).toMatchObject({ group: 'Options', type: 'boolean', widget: { kind: 'checkbox' } });
    expect(ps[5].widget).toMatchObject({ kind: 'vector', length: 3, min: 0, max: 10 });
    expect(ps[6].widget).toEqual({ kind: 'text', maxLength: 8 });
    expect(groupParameters(ps).map((g) => g.name)).toEqual(['Size', 'Options']);
  });
});
