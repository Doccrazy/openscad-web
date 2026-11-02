export type RGBA = [number, number, number, number];

export interface ViewerTheme {
  background: RGBA;
  /** Optional second background color for a vertical gradient. */
  backgroundBottom?: RGBA;
  /** Color of uncolored objects. */
  model: RGBA;
  /** Color of surfaces cut by uncolored subtracted objects. */
  cut: RGBA;
  /** Color of `#` highlighted objects (should be translucent). */
  highlight: RGBA;
  /** Color of `%` background objects (should be translucent). */
  backgroundModifier: RGBA;
  edges: RGBA;
  grid: RGBA;
  gridMajor: RGBA;
}

export const LIGHT_THEME: ViewerTheme = {
  background: [0.97, 0.97, 0.96, 1],
  backgroundBottom: [0.86, 0.88, 0.9, 1],
  model: [0.98, 0.84, 0.17, 1],
  cut: [0.62, 0.8, 0.32, 1],
  highlight: [1, 0.32, 0.32, 0.45],
  backgroundModifier: [0.55, 0.55, 0.6, 0.22],
  edges: [0, 0, 0, 0.35],
  grid: [0, 0, 0, 0.07],
  gridMajor: [0, 0, 0, 0.16],
};

export const DARK_THEME: ViewerTheme = {
  background: [0.16, 0.17, 0.19, 1],
  backgroundBottom: [0.09, 0.1, 0.11, 1],
  model: [0.98, 0.84, 0.17, 1],
  cut: [0.62, 0.8, 0.32, 1],
  highlight: [1, 0.32, 0.32, 0.45],
  backgroundModifier: [0.75, 0.75, 0.8, 0.2],
  edges: [0, 0, 0, 0.45],
  grid: [1, 1, 1, 0.06],
  gridMajor: [1, 1, 1, 0.14],
};
