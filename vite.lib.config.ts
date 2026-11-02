import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** Library build: ESM modules for every layer plus the worker entry. */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    lib: {
      formats: ['es'],
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        lang: resolve(__dirname, 'src/lang/index.ts'),
        eval: resolve(__dirname, 'src/eval/index.ts'),
        geometry: resolve(__dirname, 'src/geometry/index.ts'),
        engine: resolve(__dirname, 'src/engine/index.ts'),
        customizer: resolve(__dirname, 'src/customizer/index.ts'),
        viewer: resolve(__dirname, 'src/viewer/index.ts'),
        worker: resolve(__dirname, 'src/engine/worker.ts'),
      },
    },
    rollupOptions: {
      external: ['manifold-3d', 'opentype.js', /^node:/],
    },
  },
});
