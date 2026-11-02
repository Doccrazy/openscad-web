/**
 * The CSG tree produced by the evaluator. It is plain, JSON-serializable data
 * so it can be cached, hashed or transferred to a worker.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** RGBA, components in 0..1 */
export type Color = [number, number, number, number];

export interface Fragments {
  fn: number;
  fa: number;
  fs: number;
}

export interface SourceRef {
  file?: string;
  pos: number;
  end: number;
}

interface Base {
  /** Source location of the instantiation that created this node. */
  src?: SourceRef;
}

export interface CubeNode extends Base { type: 'cube'; size: Vec3; center: boolean }
export interface SphereNode extends Base { type: 'sphere'; r: number; segments: number }
export interface CylinderNode extends Base {
  type: 'cylinder';
  h: number;
  r1: number;
  r2: number;
  center: boolean;
  segments: number;
}
export interface PolyhedronNode extends Base { type: 'polyhedron'; points: Vec3[]; faces: number[][] }
export interface SquareNode extends Base { type: 'square'; size: Vec2; center: boolean }
export interface CircleNode extends Base { type: 'circle'; r: number; segments: number }
export interface PolygonNode extends Base { type: 'polygon'; points: Vec2[]; paths?: number[][] }
export interface TextNode extends Base {
  type: 'text';
  text: string;
  size: number;
  font: string;
  halign: string;
  valign: string;
  spacing: number;
  direction: string;
  segments: number;
}
/** Pre-triangulated mesh, e.g. from import(). Not necessarily manifold. */
export interface MeshNode extends Base {
  type: 'mesh';
  /** Unique key (e.g. file path + content hash) used for caching. */
  key: string;
  positions: number[];
  indices: number[];
}

export interface TransformNode extends Base { type: 'transform'; matrix: number[]; children: GeomNode[] }
export interface ColorNode extends Base { type: 'color'; color: Color; children: GeomNode[] }
export interface GroupNode extends Base {
  type: 'group' | 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski' | 'render';
  children: GeomNode[];
}
export interface LinearExtrudeNode extends Base {
  type: 'linear_extrude';
  height: number;
  center: boolean;
  twist: number;
  /** Explicit number of slices or undefined to derive from fragments. */
  slices?: number;
  scale: Vec2;
  frag: Fragments;
  children: GeomNode[];
}
export interface RotateExtrudeNode extends Base {
  type: 'rotate_extrude';
  angle: number;
  frag: Fragments;
  children: GeomNode[];
}
export interface OffsetNode extends Base {
  type: 'offset';
  /** Rounded offset radius, or undefined if `delta` is used. */
  r?: number;
  delta?: number;
  chamfer: boolean;
  frag: Fragments;
  children: GeomNode[];
}
export interface ProjectionNode extends Base { type: 'projection'; cut: boolean; children: GeomNode[] }
export interface ResizeNode extends Base {
  type: 'resize';
  size: Vec3;
  auto: [boolean, boolean, boolean];
  children: GeomNode[];
}
export interface ModifierNode extends Base {
  type: 'modifier';
  mode: 'highlight' | 'background';
  children: GeomNode[];
}

export type GeomNode =
  | CubeNode
  | SphereNode
  | CylinderNode
  | PolyhedronNode
  | SquareNode
  | CircleNode
  | PolygonNode
  | TextNode
  | MeshNode
  | TransformNode
  | ColorNode
  | GroupNode
  | LinearExtrudeNode
  | RotateExtrudeNode
  | OffsetNode
  | ProjectionNode
  | ResizeNode
  | ModifierNode;

export function hasChildren(n: GeomNode): n is Extract<GeomNode, { children: GeomNode[] }> {
  return 'children' in n;
}

/** OpenSCAD's get_fragments_from_r. */
export function fragmentsForRadius(r: number, f: Fragments): number {
  const GRID_FINE = 0.00000095367431640625;
  if (r < GRID_FINE || !Number.isFinite(r)) return 3;
  if (f.fn > 0) return Math.max(3, Math.floor(f.fn));
  return Math.ceil(Math.max(Math.min(360 / f.fa, (r * 2 * Math.PI) / f.fs), 5));
}
