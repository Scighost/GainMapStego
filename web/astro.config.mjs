// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  vite: {
    build: {
      // Allow large bundles for image-processing code
      chunkSizeWarningLimit: 1500,
    },
  },
});
