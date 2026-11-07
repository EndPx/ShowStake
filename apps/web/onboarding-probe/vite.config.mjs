// Vite config for the ShowStake T02 onboarding probe harness.
// This is a MINIMAL DIAGNOSTIC harness, not product UI. It imports the real
// @hot-labs/near-connect and near-api-js SDKs and runs read-only + offchain
// NEP-413 proof-of-control flows against NEAR testnet.
//
// The harness is the ONLY thing built here; it does not touch the main app,
// the database, the API contract, or product design.

import { defineConfig } from 'vite';

export default defineConfig({
  // `root` is the directory `vite` is pointed at (apps/web/onboarding-probe),
  // so these paths are relative to that root.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: false,
    host: '127.0.0.1',
  },
  // near-api-js and @hot-labs/near-connect are the only real dependencies; both
  // are browser-safe. Keep the optimizer including them so named ESM imports of the
  // CommonJS @hot-labs/near-connect resolve deterministically.
  optimizeDeps: {
    include: ['@hot-labs/near-connect', 'near-api-js', 'near-api-js/nep413'],
  },
});