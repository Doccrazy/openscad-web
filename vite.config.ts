import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  base: './',
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['manifold-3d'] },
  server: { fs: { allow: ['..'] } },
});
