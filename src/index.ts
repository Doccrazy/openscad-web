/**
 * openscad-web: a standalone OpenSCAD interpreter, geometry engine and viewer.
 *
 * Layers (each usable on its own):
 *  - `lang`       – lexer / parser / AST
 *  - `eval`       – interpreter producing a CSG tree
 *  - `geometry`   – CSG tree → meshes (manifold-3d WASM)
 *  - `engine`     – parse+eval+geometry pipeline, worker + client
 *  - `customizer` – OpenSCAD customizer parameter extraction
 *  - `viewer`     – WebGL2 viewer with order-independent transparency
 */
export * from './lang';
export * from './eval';
export * from './geometry';
export * from './engine';
export * from './customizer';
export * from './viewer';
