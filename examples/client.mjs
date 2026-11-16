import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const binPath = fileURLToPath(new URL('../bin/copilot-orchestrator.mjs', import.meta.url));

/** Start a local `serve` host and speak its line-delimited JSON protocol. */
export function createClient(options = {}) {
  const args = [binPath, 'serve'];
  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.dataDir) args.push('--data-dir', options.dataDir);
  if (options.model) args.push('--model', options.model);
  if (options.events) args.push('--events');

  const child = spawn(process.execPath, args, {
    cwd: options.launchCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let closeResolve;
  let closeReject;
  const exit = new Promise((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  // Avoid an unhandled rejection when the caller hasn't awaited close yet.
  void exit.catch(() => {});

  function failPending(error) {
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(error);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        failPending(new Error(`CLI emitted invalid JSON: ${line}`, { cause: error }));
        continue;
      }
      if (message?.method === 'event') {
        options.onEvent?.(message.params);
        continue;
      }
      const request = pending.get(String(message?.id));
      if (!request) continue;
      pending.delete(String(message.id));
      if (Object.hasOwn(message, 'error')) request.reject(new Error(String(message.error)));
      else request.resolve(message.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });
  child.once('error', (error) => {
    closed = true;
    failPending(error);
    closeReject(error);
  });
  child.once('exit', (code, signal) => {
    closed = true;
    const detail = `CLI serve exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`;
    const error = new Error(detail);
    failPending(error);
    if (code === 0) closeResolve({ code, signal, stderr });
    else closeReject(error);
  });

  return {
    child,
    exit,
    get stderr() { return stderr; },
    request(method, params = {}) {
      if (closed || child.stdin.destroyed) return Promise.reject(new Error('CLI serve is closed.'));
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
    },
    async close({ timeoutMs = 5_000 } = {}) {
      if (!closed && !child.stdin.destroyed) child.stdin.end();
      let timeout;
      try {
        return await Promise.race([
          exit,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`CLI serve did not exit within ${timeoutMs} ms.`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        // Only terminate the exact child process created by this client.
        if (!closed && child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.race([exit.catch(() => {}), delay(1_000)]);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
