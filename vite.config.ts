/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const googleApiProxy = {
  '/api/google-admin': {
    target: 'https://admin.googleapis.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/google-admin/, ''),
  },
  '/api/google-bigquery': {
    target: 'https://bigquery.googleapis.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/google-bigquery/, ''),
  },
  '/api/google-crm': {
    target: 'https://cloudresourcemanager.googleapis.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/google-crm/, ''),
  },
  '/api/google-serviceusage': {
    target: 'https://serviceusage.googleapis.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/google-serviceusage/, ''),
  },
  '/api/google-oauth2': {
    target: 'https://oauth2.googleapis.com',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/google-oauth2/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: googleApiProxy,
  },
  preview: {
    proxy: googleApiProxy,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts', 'echarts-for-react'],
          vendor: ['react', 'react-dom', 'lucide-react', 'date-fns', 'axios'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
