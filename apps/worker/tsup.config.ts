import { defineConfig } from 'tsup';

// Production worker bundle. We bundle everything — including the workspace
// packages consumed as TypeScript source and `pg` — into a single self-contained
// ESM file so the runtime image needs nothing but Node and `dist/index.js`.
// `pg-native` (optional) and the Cloudflare-sockets shim are not used and stay
// external so esbuild doesn't try to resolve them. `sharp` (album-art rendition
// for ID3 embedding) is a NATIVE module that cannot be bundled — it stays
// external and is installed into the worker runtime image (see Dockerfile) and
// resolved at runtime through the createRequire banner below.
export default defineConfig({
  // `index` is the worker daemon; `reset-admin-password` is the bundled ops CLI
  // (`docker compose exec worker node dist/reset-admin-password.js`);
  // `migrate-stack` is the one-shot migration the compose `migrate` service runs;
  // `estimator-worker` is the tempo-estimator worker_threads entry the daemon
  // spawns at runtime — it must land as `dist/estimator-worker.js`, a SIBLING of
  // `dist/index.js`, because `runEstimatorInThread` resolves it relative to the
  // bundle (hence the object form: the array form would nest it under `audio/`).
  entry: {
    index: 'src/index.ts',
    'reset-admin-password': 'src/reset-admin-password.ts',
    'migrate-stack': 'src/migrate-stack.ts',
    'estimator-worker': 'src/audio/estimator-worker.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  noExternal: [/.*/],
  external: ['pg-native', 'cloudflare:sockets', 'sharp'],
  // `pg` is CommonJS and uses dynamic `require('events')` etc. When bundled into
  // an ESM file, esbuild's `__require` shim throws unless a real module-scoped
  // `require` exists. Provide one via createRequire.
  banner: {
    js: "import { createRequire as __liedmotifCreateRequire } from 'node:module'; const require = __liedmotifCreateRequire(import.meta.url);",
  },
});
