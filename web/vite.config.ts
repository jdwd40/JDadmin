import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev: the API runs on the server workspace (default PORT=4100).
      '/api': { target: 'http://localhost:4100', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
