export interface RenderHandle {
  /** Resolves after asynchronous Markdown parsing/highlighting finishes. */
  readonly ready: Promise<void>;
  /** Removes rendered content and all listeners owned by the renderer. */
  readonly cleanup: () => void;
}

export function makeHandle(cleanup: () => void, ready: Promise<void> = Promise.resolve()): RenderHandle {
  let cleaned = false;
  return {
    ready,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      cleanup();
    },
  };
}
