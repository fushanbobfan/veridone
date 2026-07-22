import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = `http://127.0.0.1:${process.env.VERIDONE_API_PORT ?? '4317'}`;

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VERIDONE_WEB_PORT ?? '4173'),
    strictPort: process.env.VERIDONE_STRICT_PORT === '1',
    proxy: {
      '/api': apiProxy,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.VERIDONE_WEB_PORT ?? '4173'),
    strictPort: process.env.VERIDONE_STRICT_PORT === '1',
    proxy: {
      '/api': apiProxy,
    },
  },
});
