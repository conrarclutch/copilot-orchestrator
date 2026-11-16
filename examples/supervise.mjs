#!/usr/bin/env node
import { createClient } from './client.mjs';

function parseArgs(args) {
  const options = { cwd: process.cwd(), timeoutMs: 30 * 60_000 };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cwd') options.cwd = args[++i];
    else if (arg === '--data-dir') options.dataDir = args[++i];
    else if (arg === '--model') options.model = args[++i];
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++i]);
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms must be positive.');
  return { options, prompt: positional.join(' ') || defaultPrompt };
}

const defaultPrompt = [
  'Use task delegation with mode="wait" to ask exactly two child agents to do independent work.',
  'The first child must reply with exactly ALPHA. The second child must reply with exactly BETA.',
  'After both child replies arrive, respond with exactly ALPHA+BETA and no other text.',
].join(' ');

async function main() {
  const { options, prompt } = parseArgs(process.argv.slice(2));
  const client = createClient(options);
  try {
    const createdProject = await client.request('project.create', {
      title: 'Local orchestration example',
      workspaceRoot: options.cwd,
      createWorkspaceRootIfMissing: false,
    });
    const project = createdProject.project ?? createdProject;
    const { threadId, runId } = await client.request('thread.create', {
      projectId: project.id,
      title: prompt.slice(0, 80),
      runtimeMode: 'full-access', // Unattended demo; production threads default to approval-required.
      prompt,
    });
    if (!runId) throw new Error('thread.create did not return a runId.');
    const waited = await client.request('thread.wait', {
      threadId,
      runId,
      timeoutMs: options.timeoutMs,
    });
    const read = await client.request('thread.read', { threadId, runLimit: 20, limit: 100 });
    const finalAssistant = read.items.filter((item) => item.type === 'assistant_message' && item.text).at(-1);
    process.stdout.write(JSON.stringify({
      projectId: project.id,
      threadId,
      runId,
      status: waited.run?.status ?? waited.status ?? 'unknown',
      answer: finalAssistant?.text ?? null,
      items: read.items,
    }, null, 2) + '\n');
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
