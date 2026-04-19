import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    sourcemap: false,
    outDir: 'dist',
    assetsInlineLimit: 8192,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/metrics': 'http://127.0.0.1:8788',
    },
  },
});
