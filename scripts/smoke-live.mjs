#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../examples/client.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const summaryArg = process.argv.slice(2).find((arg) => arg.startsWith('--expected-marker='));
const expectedMarker = summaryArg?.slice('--expected-marker='.length) || 'ALPHA+BETA';
if (!process.argv.includes('--run-live')) {
  process.stdout.write('Live smoke is opt-in. Run with --run-live to start real Copilot SDK sessions.\n');
  process.exit(0);
}

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const stateRoot = path.join(repoRoot, '.orchestrator', `live-smoke-${runId}`);
const workspaceRoot = path.join(stateRoot, 'workspace');
const dataDir = path.join(stateRoot, 'data');
const summaryPath = path.join(stateRoot, 'summary.json');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30 * 60_000);
const modelArg = process.argv.slice(2).find((arg) => arg.startsWith('--model='));
const model = modelArg?.slice('--model='.length) || process.env.COPILOT_MODEL || 'auto';

async function request(client, method, params = {}, timeout = timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      client.request(method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeout} ms`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message || result.status}`);
  }
}

async function initializeOwnedRepository() {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'README.md'), '# Copilot orchestration live smoke\n');
  git(['init', '-q']);
  git(['config', 'user.name', 'Copilot Orchestrator Smoke']);
  git(['config', 'user.email', 'copilot-orchestrator-smoke@localhost']);
  git(['add', 'README.md']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'live smoke baseline']);
}

function verifyDatabase({ dbPath, minThreads, minChildren }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const threadCount = db.prepare('SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads').get().count;
    const childCount = db.prepare(`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents
      WHERE origin = 'app_owned' AND child_thread_id IS NOT NULL
    `).get().count;
    assert.ok(threadCount >= minThreads, `expected >= ${minThreads} persisted threads, got ${threadCount}`);
    assert.ok(childCount >= minChildren, `expected >= ${minChildren} managed child records, got ${childCount}`);
    return { threadCount, childCount };
  } finally {
    db.close();
  }
}

async function run() {
  await mkdir(stateRoot, { recursive: true });
  await initializeOwnedRepository();
  const events = [];
  const first = createClient({
    cwd: workspaceRoot,
    dataDir,
    model,
    events: true,
    onEvent: (event) => events.push(event),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  let record;
  try {
    const created = await request(first, 'project.create', {
      title: 'Copilot live smoke', workspaceRoot, createWorkspaceRootIfMissing: false,
    });
    const project = created.project ?? created;
    const initialPrompt = [
      'Prove this is an actual SDK conversation by having your parent and children delegate live work.',
      'Use delegate_task with mode="wait" to create exactly two child agents, each on a separate task.',
      'The first child must reply with exactly ALPHA. The second child must reply with exactly BETA.',
      `After both child results return, your final answer must contain the exact marker ${expectedMarker}.`,
      'Do not claim child work unless the orchestration tool reports completed child results.',
    ].join(' ');
    const parent = await request(first, 'thread.create', {
      projectId: project.id, title: 'Live parent/child SDK verification', prompt: initialPrompt, runtimeMode: 'full-access',
    });
    assert.ok(parent.runId, 'prompt thread creation must return a runId');
    const waited = await request(first, 'thread.wait', {
      threadId: parent.threadId, runId: parent.runId, timeoutMs,
    });
    assert.equal(waited.timedOut, false, 'parent run must finish before timeout');
    const read = await request(first, 'thread.read', { threadId: parent.threadId, runLimit: 20, limit: 100 });
    const answer = read.items.filter((item) => item.type === 'assistant_message' && item.runId === parent.runId)
      .map((item) => item.text ?? '').join('\n');
    assert.ok(answer.includes(expectedMarker), `parent assistant result must contain ${expectedMarker}`);
    const parentStatus = await request(first, 'thread.status', { threadId: parent.threadId });
    assert.equal(parentStatus.latestRun.status, 'completed');
    const persistedCounts = verifyDatabase({ dbPath: path.join(dataDir, 'userdata', 'statev2.sqlite'), minThreads: 3, minChildren: 2 });
    const worktreeResult = await request(first, 'worktree.create', {
      cwd: workspaceRoot, refName: 'HEAD', newRefName: `smoke/${runId}`, path: null,
    });
    const worktreePath = worktreeResult.worktree.path;
    await access(worktreePath);
    const isolated = await request(first, 'thread.create', {
      projectId: project.id, title: 'Worktree isolation probe', worktreePath,
    });
    const isolatedStatus = await request(first, 'thread.status', { threadId: isolated.threadId });
    assert.equal(path.resolve(isolatedStatus.thread.worktreePath), path.resolve(worktreePath), 'thread must retain its isolated worktree');

    // Exercise explicit idempotency for a user follow-up, including a retry of
    // the identical request envelope after the first call has returned.
    const followupInput = {
      threadId: parent.threadId,
      message: 'Reply with exactly RESUMED_OK.',
      mode: 'auto',
      clientRequestId: `live-smoke-followup-${runId}`,
    };
    const followup = await request(first, 'thread.send', followupInput);
    const retry = await request(first, 'thread.send', followupInput);
    assert.equal(retry.runId, followup.runId, 'retrying thread.send with the same clientRequestId must reuse its runId');
    const followupWait = await request(first, 'thread.wait', {
      threadId: parent.threadId, runId: followup.runId, timeoutMs,
    });
    assert.equal(followupWait.timedOut, false, 'follow-up run must finish before timeout');
    const followupRead = await request(first, 'thread.read', { threadId: parent.threadId, limit: 100 });
    assert.ok(followupRead.items.some((item) => item.type === 'assistant_message' && item.runId === followup.runId
      && item.text?.includes('RESUMED_OK')), 'follow-up must produce an assistant result');
    record = { projectId: project.id, parentThreadId: parent.threadId, followupRunId: followup.runId, expectedMarker, answer, persistedCounts, worktreePath, eventsSeen: events.length };
  } finally {
    await first.close();
  }

  // Restart the host over the same isolated database and prove reads survive.
  const second = createClient({ cwd: workspaceRoot, dataDir, model, onStderr: (chunk) => process.stderr.write(chunk) });
  try {
    const listed = await request(second, 'thread.list', { projectId: record.projectId, limit: 100 });
    const listedThreads = Array.isArray(listed) ? listed : listed.threads;
    assert.ok(listedThreads?.some((thread) => thread.id === record.parentThreadId || thread.threadId === record.parentThreadId),
      'restarted host must list the persisted parent thread');
    const read = await request(second, 'thread.read', { threadId: record.parentThreadId, runLimit: 20, limit: 100 });
    const persistedText = read.items.filter((item) => item.type === 'assistant_message').map((item) => item.text ?? '').join('\n');
    assert.ok(persistedText.includes(record.expectedMarker), 'restarted host must read the parent result');

    // Verify stable creation idempotency after restart. No prompt is attached,
    // so this check does not create another provider session or inference turn.
    const createKey = `live-smoke-thread-create-${runId}`;
    const createInput = {
      projectId: record.projectId,
      title: 'Idempotent create probe',
      clientRequestId: createKey,
    };
    const createdOnce = await request(second, 'thread.create', createInput);
    const createdAgain = await request(second, 'thread.create', createInput);
    assert.equal(createdAgain.threadId, createdOnce.threadId,
      'thread.create retry with same clientRequestId must return same thread id');
    const listAfterCreate = await request(second, 'thread.list', { projectId: record.projectId, limit: 100 });
    const allThreads = Array.isArray(listAfterCreate) ? listAfterCreate : listAfterCreate.threads;
    const matching = allThreads.filter((thread) => (thread.id ?? thread.threadId) === createdOnce.threadId);
    assert.equal(matching.length, 1, 'idempotent thread.create must not duplicate the persisted thread');
    record = { ...record, restartRead: true, stableThreadCreateId: createdOnce.threadId };
  } finally {
    await second.close();
  }

  await writeFile(summaryPath, JSON.stringify({
    status: 'passed',
    createdAt: new Date().toISOString(),
    model,
    workspaceRoot,
    dataDir,
    ...record,
  }, null, 2) + '\n');
  process.stdout.write(`Live smoke passed. Preserved isolated workspace and state at ${stateRoot}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
