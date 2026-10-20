import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/** The shell is served by the site, so the page imports it at run time and shares its sign-in. The fonts are bundled, because the site's CSP allows font-src 'self' only. */
export default defineConfig({
  base: '/g/drawpad/',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: { external: ['/shell/v1/index.js'] },
  },
});
