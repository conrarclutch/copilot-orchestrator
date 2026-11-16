#!/usr/bin/env node
import { existsSync } from 'node:fs';

try {
  const builtEntry = new URL('../dist/cli.mjs', import.meta.url);
  let entry = builtEntry;
  if (!existsSync(builtEntry)) {
    const { register } = await import('tsx/esm/api');
    register();
    entry = new URL('../packages/core/src/local-orchestrator/cli.ts', import.meta.url);
  }
  const { main } = await import(entry.href);
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
