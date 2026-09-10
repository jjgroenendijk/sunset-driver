import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // three/webgpu is one large module by nature; the warning is noise here.
    chunkSizeWarningLimit: 1500,
  },
});
