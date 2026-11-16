import type { Writable } from "node:stream";

/** A JSON-RPC/event value written as one newline-delimited JSON record. */
export type JsonLineWriter = ((value: unknown) => Promise<void>) & {
  /** Method form for callers that prefer an object-like writer. */
  readonly write: (value: unknown) => Promise<void>;
};

/**
 * The small part of a stored event needed to resume a local event stream.
 *
 * Keep `sequence` outside the event itself: it is assigned by EventSink and is
 * the cursor the client must send back in `events-after`.
 */
export interface StoredEventLike<TEvent extends object = object> {
  readonly sequence: number;
  readonly event: TEvent;
}

export interface EventEnvelope<TParams extends object = object> {
  readonly method: "event";
  readonly params: TParams;
}

/**
 * Build the wire envelope for a replayed/live stored event.
 *
 * The sequence is deliberately copied from the stored row after spreading the
 * event. This prevents a stale or provider-supplied `event.sequence` from
 * becoming the replay cursor.
 */
export function makeEventEnvelope<TEvent extends object>(
  stored: StoredEventLike<TEvent>,
): EventEnvelope<Omit<TEvent, "sequence"> & { readonly sequence: number }> {
  return {
    method: "event",
    params: {
      ...stored.event,
      sequence: stored.sequence,
    } as Omit<TEvent, "sequence"> & { readonly sequence: number },
  };
}

/** Normalize non-Error values while preserving Error identity for callers. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Write one line and wait for the stream to accept and flush it.
 *
 * A Writable callback indicates that the chunk has been handled. When
 * `write()` returns false, `drain` is also required before resolving. All
 * listeners are removed on every terminal path, including a closed stream.
 */
function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackCompleted = false;
    let drainCompleted = false;
    let needsDrain = false;

    const cleanup = (): void => {
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };

    const resolveIfReady = (): void => {
      if (writeReturned && callbackCompleted && (!needsDrain || drainCompleted)) {
        settleResolve();
      }
    };

    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(asError(cause));
    };

    const onDrain = (): void => {
      drainCompleted = true;
      resolveIfReady();
    };

    const onError = (cause: unknown): void => {
      settleReject(cause);
    };

    const onClose = (): void => {
      settleReject(new Error("Output stream closed before the JSON line was written."));
    };

    // Attach before write(): a small test/durable stream is allowed to emit
    // drain/error synchronously from its write implementation.
    output.on("drain", onDrain);
    output.on("error", onError);
    output.on("close", onClose);

    const callback = (cause?: Error | null): void => {
      if (settled) return;
      if (cause !== undefined && cause !== null) {
        settleReject(cause);
        return;
      }
      callbackCompleted = true;
      resolveIfReady();
    };

    try {
      // Writable.write() returns false when its internal buffer is full. Do
      // not resolve until the corresponding drain event is observed.
      const accepted = output.write(line, callback);
      needsDrain = accepted === false;
      drainCompleted = !needsDrain;
      writeReturned = true;
      resolveIfReady();
    } catch (cause) {
      settleReject(cause);
    }
  });
}

/**
 * Create a serialized NDJSON writer for a local RPC/event stream.
 *
 * Calls may be made concurrently. They are queued in call order, so a line
 * can never be interleaved with another line. Only the currently written
 * chunk has stream listeners; settled writes remove them before the next one
 * starts. Once the stream fails, queued and future writes reject without
 * emitting more bytes.
 */
export function makeJsonLineWriter(output: Writable = process.stdout): JsonLineWriter {
  let tail: Promise<void> = Promise.resolve();
  let failed = false;
  let failure: unknown;

  const write = (value: unknown): Promise<void> => {
    let line: string;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new TypeError("JSON line values must be JSON-serializable objects or primitives.");
      }
      line = `${encoded}\n`;
    } catch (cause) {
      return Promise.reject(cause);
    }

    const operation = tail.then(async () => {
      if (failed) {
        throw failure;
      }
      try {
        await writeLine(output, line);
      } catch (cause) {
        failed = true;
        failure = cause;
        throw cause;
      }
    });

    // Keep the queue chain fulfilled after a failure. That lets later calls
    // reach the shared failure check instead of accumulating rejected tails.
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const writer = write as JsonLineWriter;
  Object.defineProperty(writer, "write", {
    configurable: false,
    enumerable: false,
    value: write,
    writable: false,
  });
  return writer;
}
