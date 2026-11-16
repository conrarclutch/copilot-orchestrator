import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['packages/core/src/local-orchestrator/cli.ts'],
  outfile: 'dist/cli.mjs',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  external: [
    '@github/copilot-sdk',
    '@ff-labs/fff-node',
    'effect', 'effect/*',
    '@effect/platform-node', '@effect/platform-node/*',
    '@effect/platform-node-shared', '@effect/platform-node-shared/*',
  ],
  sourcemap: true,
  metafile: true,
});
await writeFile('dist/dependencies.json', JSON.stringify(result.metafile, null, 2));
console.log('Built the local T3 orchestration CLI in dist/cli.mjs');
await import('../packages/chat-renderer/build.mjs');
