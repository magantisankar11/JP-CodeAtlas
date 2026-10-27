import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // changeOrigin stays false: the API checks the forwarded Host/Origin and allows this dev server (server/src/security.ts).
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
