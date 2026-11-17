import { defineConfig } from 'vite';

// Dev and preview servers listen on localhost only; use `npm run dev -- --host`
// to test from another device on the same network.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
