import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/eval';

function echo(src: string): string[] {
  const r = evaluate(src);
  const errs = r.messages.filter((m) => m.level === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.text).join('\n'));
  return r.messages.filter((m) => m.level === 'echo').map((m) => m.text);
}

describe('expressions', () => {
  it('arithmetic & formatting', () => {
    expect(echo('echo(1+2*3, 2^3^2, -2^2, 10%3, 1/3, 1e6, 123456789, 0.1+0.2);')).toEqual([
      '7, 512, -4, 1, 0.333333, 1e+06, 1.23457e+08, 0.3',
    ]);
  });
  it('vectors & matrices', () => {
    expect(echo('echo([1,2]+[3,4], [1,2,3]*[1,1,1], [[1,0],[0,2]]*[3,4], 2*[1,2]);')).toEqual(['[4, 6], 6, [3, 8], [2, 4]']);
  });
  it('strings', () => {
    expect(echo('echo(str("a", 1, [1,"x"]), len("héllo"), "abc"[1], chr(65,66), ord("A"));')).toEqual([
      '"a1[1, \\"x\\"]", 5, "b", "AB", 65',
    ]);
  });
  it('list comprehensions', () => {
    expect(
      echo('echo([for (i=[0:4]) if (i%2==0) i*i], [for (i=[0:2], j=[0:1]) [i,j]][3], [each [1,2], 3], [for (i=0;i<3;i=i+1) i], [let(a=2) a*a]);'),
    ).toEqual(['[0, 4, 16], [1, 1], [1, 2, 3], [0, 1, 2], [4]']);
  });
  it('functions, recursion & tail calls', () => {
    expect(
      echo(`
        function fact(n) = n <= 1 ? 1 : n * fact(n-1);
        function sum(n, acc=0) = n == 0 ? acc : sum(n-1, acc+n);
        f = function(x) x * 2;
        echo(fact(10), sum(100000), f(21), let(g = function(y) y + 1) g(1));
      `),
    ).toEqual(['3.6288e+06, 5.00005e+09, 42, 2']);
  });
  it('special variables are dynamically scoped', () => {
    expect(echo('module m() { echo($fn); } m(); m($fn=8); $fn=3; m();')).toEqual(['3', '8', '3']);
  });
  it('assignment hoisting', () => {
    expect(echo('a = 1; echo(a); a = 2;')).toEqual(['2']);
  });
  it('builtins', () => {
    expect(echo('echo(max([1,5,3]), min(4,2), norm([3,4]), cross([1,0,0],[0,1,0]), lookup(1.5, [[1,10],[2,20]]), search("a","abcabc"), round(-2.5), sin(30), concat([1],[2,3],4));')).toEqual([
      '5, 2, 5, [0, 0, 1], 15, [0], -3, 0.5, [1, 2, 3, 4]',
    ]);
  });
  it('assert fails with message', () => {
    const r = evaluate('assert(1 == 2, "nope");');
    expect(r.failed).toBe(true);
    expect(r.messages[0].text).toContain('nope');
  });
});

describe('geometry tree', () => {
  it('modules & children', () => {
    const r = evaluate(`
      module pair() { children(0); translate([10,0,0]) children(1); }
      pair() { cube(1); sphere(2, $fn=12); }
    `);
    expect(r.messages.filter((m) => m.level !== 'echo')).toEqual([]);
    expect(r.nodes.length).toBe(1);
    const g = r.nodes[0] as any;
    expect(g.type).toBe('group');
    expect(g.children[0].type).toBe('cube');
    expect(g.children[1].type).toBe('transform');
    expect(g.children[1].children[0]).toMatchObject({ type: 'sphere', r: 2, segments: 12 });
  });
  it('modifiers', () => {
    const r = evaluate('difference() { cube(10); #cylinder(h=20, r=2); %sphere(1); *cube(3); }');
    const d = r.nodes[0] as any;
    expect(d.children.map((c: any) => c.type)).toEqual(['cube', 'modifier', 'modifier']);
    expect(d.children[1].mode).toBe('highlight');
  });
  it('root modifier', () => {
    const r = evaluate('cube(1); !sphere(1); cylinder();');
    expect(r.nodes.map((n) => n.type)).toEqual(['sphere']);
  });
  it('for loop', () => {
    const r = evaluate('for (i=[0:2]) translate([i,0,0]) cube(1);');
    expect((r.nodes[0] as any).children.length).toBe(3);
  });
});
