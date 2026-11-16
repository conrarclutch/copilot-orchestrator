import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { makeEventEnvelope, makeJsonLineWriter } from "./transport.ts";

/** A controllable Writable-shaped stream; no real stdout or filesystem I/O. */
class FakeWritable extends EventEmitter {
  readonly chunks: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  autoComplete = true;
  backpressure = false;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    if (callback !== undefined) {
      this.callbacks.push(callback);
      if (this.autoComplete) {
        queueMicrotask(() => this.complete());
      }
    }
    return !this.backpressure;
  }

  complete(error?: Error): void {
    const callback = this.callbacks.shift();
    callback?.(error);
    if (error === undefined) {
      this.emit("drain");
    }
  }

  close(): void {
    this.emit("close");
  }

  listenerCountFor(event: string): number {
    return this.listenerCount(event);
  }
}

const asWritable = (stream: FakeWritable): Writable => stream as unknown as Writable;

describe("makeJsonLineWriter", () => {
  it("serializes concurrent calls as complete lines in call order", async () => {
    const output = new FakeWritable();
    const write = makeJsonLineWriter(asWritable(output));

    await Promise.all([
      write({ id: 1, message: "first" }),
      write({ id: 2, message: "second" }),
      write({ id: 3, message: "third" }),
    ]);

    expect(output.chunks).toEqual([
      '{"id":1,"message":"first"}\n',
      '{"id":2,"message":"second"}\n',
      '{"id":3,"message":"third"}\n',
    ]);
    expect(output.listenerCountFor("drain")).toBe(0);
    expect(output.listenerCountFor("error")).toBe(0);
    expect(output.listenerCountFor("close")).toBe(0);
  });

  it("waits for drain when write applies backpressure", async () => {
    const output = new FakeWritable();
    output.autoComplete = false;
    output.backpressure = true;
    const write = makeJsonLineWriter(asWritable(output));
    let settled = false;

    const pending = write({ id: "backpressure" }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(output.listenerCountFor("drain")).toBe(1);
    expect(output.listenerCountFor("error")).toBe(1);
    expect(output.listenerCountFor("close")).toBe(1);

    output.complete();
    await pending;

    expect(settled).toBe(true);
    expect(output.listenerCountFor("drain")).toBe(0);
    expect(output.listenerCountFor("error")).toBe(0);
    expect(output.listenerCountFor("close")).toBe(0);
  });

  it("rejects on stream errors and rejects queued writes without writing them", async () => {
    const output = new FakeWritable();
    output.autoComplete = false;
    const write = makeJsonLineWriter(asWritable(output));
    const first = write({ id: 1 });
    const second = write({ id: 2 });
    const failure = new Error("socket failed");
    const firstResult = expect(first).rejects.toBe(failure);
    const secondResult = expect(second).rejects.toBe(failure);

    // Let the serialized operation install its stream listeners before the
    // fake stream emits an error (a real write starts on the next turn too).
    await Promise.resolve();
    output.emit("error", failure);

    await firstResult;
    await secondResult;
    expect(output.chunks).toEqual(['{"id":1}\n']);
    expect(output.listenerCountFor("drain")).toBe(0);
    expect(output.listenerCountFor("error")).toBe(0);
    expect(output.listenerCountFor("close")).toBe(0);
  });

  it("rejects when the output closes and removes all listeners", async () => {
    const output = new FakeWritable();
    output.autoComplete = false;
    const write = makeJsonLineWriter(asWritable(output));
    const pending = write({ id: "closed" });

    await Promise.resolve();
    output.close();

    await expect(pending).rejects.toThrow("closed before the JSON line was written");
    expect(output.listenerCountFor("drain")).toBe(0);
    expect(output.listenerCountFor("error")).toBe(0);
    expect(output.listenerCountFor("close")).toBe(0);
  });
});

describe("makeEventEnvelope", () => {
  it("uses the stored row sequence as the replay cursor", () => {
    expect(
      makeEventEnvelope({
        sequence: 42,
        event: { type: "thread.updated", sequence: 7, threadId: "thread-1" },
      }),
    ).toEqual({
      method: "event",
      params: { type: "thread.updated", sequence: 42, threadId: "thread-1" },
    });
  });
});
