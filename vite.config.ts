import { defineConfig, type Plugin } from 'vite';

/** The call that decodes the WebAssembly Rapier's compat build carries inline as base64. */
const RAPIER_INLINE = /ng\.toByteArray\("[A-Za-z0-9+/=]+"\)\.buffer/;

/**
 * Rapier's compat build carries its WebAssembly inline as 2.7 MB of base64, which the
 * browser downloads inside the main script and decodes before it compiles. The package
 * ships the same file beside it, so the build points the loader at that file instead:
 * the main script shrinks, and the browser compiles the file while it streams in.
 * Only the build does this; the tests and the dev server keep the inline copy.
 */
function rapierWasmFile(): Plugin {
  return {
    name: 'rapier-wasm-file',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@dimforge/rapier3d-compat/dist/rapier.mjs')) return null;
      if (!RAPIER_INLINE.test(code)) this.error('The inline WebAssembly of Rapier was not found.');
      const file = 'new URL("./rapier_wasm3d_bg.wasm", import.meta.url)';
      return { code: code.replace(RAPIER_INLINE, file), map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [rapierWasmFile()],
  build: {
    target: 'es2022',
    // three/webgpu is one large module by nature; the warning is noise here.
    chunkSizeWarningLimit: 1500,
  },
});
