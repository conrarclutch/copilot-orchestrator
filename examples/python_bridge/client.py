"""Async Python client for the local ``copilot-orchestrator serve`` process.

This module deliberately uses only Python 3.11+ standard-library APIs.  The
Node process owns the Copilot SDK client and sessions; this class only owns the
subprocess transport and request/event lifecycle.  A caller can therefore keep
existing Python API connectors (Splunk, Tanium, Proofpoint, and so on) in its
own application without moving their credentials or session state here.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
import inspect
import json
import os
from pathlib import Path
import subprocess
from typing import Any


JsonValue = Any
EventCallback = Callable[[JsonValue], Any]


class BridgeError(RuntimeError):
    """Base class for transport and protocol failures."""


class BridgeClosedError(BridgeError):
    """The Node serve process is no longer available."""


class BridgeEOFError(BridgeClosedError):
    """The serve process ended before a response was received."""


class BridgeProtocolError(BridgeClosedError):
    """The serve process emitted a malformed or unsupported protocol line."""


class OrchestratorRequestError(BridgeError):
    """A valid request received an error response from the orchestrator."""

    def __init__(self, method: str, request_id: str, error: JsonValue) -> None:
        self.method = method
        self.request_id = request_id
        self.error = error
        # Do not include params or stderr here.  Either can contain credentials
        # or investigation data.  The structured ``error`` remains available
        # to callers that need provider details.
        super().__init__(f"orchestrator request failed: {method} ({request_id})")


@dataclass
class _PendingRequest:
    method: str
    future: asyncio.Future[JsonValue]


_EVENT_END = object()


class OrchestratorClient:
    """Keep one local Node orchestrator alive and multiplex NDJSON requests.

    The default command resolves ``bin/copilot-orchestrator.mjs`` relative to
    this source file, so an application can import the example without relying
    on its current working directory.  ``command`` is provided for tests and
    for packaging systems that expose the Node entry point under another name.

    Events are delivered to a bounded queue.  If a producer is faster than a
    consumer, the oldest queued events are dropped and the next event returned
    by :meth:`next_event` is a synthetic ``events.dropped`` marker.  A caller
    must then re-read authoritative state (normally ``thread.read`` or
    ``thread.status``) before trusting its in-memory view.
    """

    def __init__(
        self,
        *,
        node_path: str | os.PathLike[str] = "node",
        bin_path: str | os.PathLike[str] | None = None,
        cwd: str | os.PathLike[str] | None = None,
        data_dir: str | os.PathLike[str] | None = None,
        model: str | None = None,
        events: bool = True,
        events_after: int | None = None,
        mcp_config: str | os.PathLike[str] | None = None,
        launch_cwd: str | os.PathLike[str] | None = None,
        event_queue_size: int = 256,
        stderr_tail_bytes: int = 16_384,
        max_line_bytes: int = 4 * 1024 * 1024,
        event_callback: EventCallback | None = None,
        command: Sequence[str | os.PathLike[str]] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        if event_queue_size < 1:
            raise ValueError("event_queue_size must be at least 1")
        if stderr_tail_bytes < 0:
            raise ValueError("stderr_tail_bytes must not be negative")
        if max_line_bytes < 1024:
            raise ValueError("max_line_bytes must be at least 1024")
        if events_after is not None and events_after < 0:
            raise ValueError("events_after must be non-negative")

        repo_bin = Path(__file__).resolve().parents[2] / "bin" / "copilot-orchestrator.mjs"
        self.node_path = str(node_path)
        self.bin_path = Path(bin_path) if bin_path is not None else repo_bin
        self.project_cwd = Path(cwd) if cwd is not None else None
        self.data_dir = Path(data_dir) if data_dir is not None else None
        self.model = model
        self.events_enabled = events
        self.events_after = events_after
        self.mcp_config = Path(mcp_config) if mcp_config is not None else None
        self.launch_cwd = Path(launch_cwd) if launch_cwd is not None else None
        self._command_override = tuple(str(part) for part in command) if command is not None else None
        self._env_override = dict(env) if env is not None else None
        self._event_queue_size = event_queue_size
        self._stderr_tail_limit = stderr_tail_bytes
        self._max_line_bytes = max_line_bytes
        self._event_callback = event_callback

        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._callback_task: asyncio.Task[None] | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._pending: dict[str, _PendingRequest] = {}
        self._next_id = 1
        self._started = False
        self._closed = False
        self._closing = False
        self._terminal_error: BridgeClosedError | None = None
        self._event_queue: asyncio.Queue[JsonValue | object] = asyncio.Queue(maxsize=event_queue_size)
        self._callback_queue: asyncio.Queue[JsonValue | object] = asyncio.Queue(maxsize=event_queue_size)
        self._dropped_events = 0
        self._dropped_since_marker = 0
        self._resync_after_sequence: int | None = None
        # The persisted cursor is the last event returned to the consumer,
        # not merely the last event read from stdout. Event sequences are
        # monotonic but may have legitimate gaps because other streams share
        # the application log.
        self._last_event_sequence: int | None = events_after
        self._last_received_sequence: int | None = events_after
        self._dropped_callbacks = 0
        self._callback_error_count = 0
        self._stderr_chunks: deque[bytes] = deque()
        self._stderr_size = 0

    @property
    def process(self) -> asyncio.subprocess.Process | None:
        """The exact child process owned by this client, for diagnostics/tests."""

        return self._process

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None and not self._closed

    @property
    def stderr_tail(self) -> str:
        """A bounded diagnostic tail; callers should avoid logging it by default."""

        return b"".join(self._stderr_chunks).decode("utf-8", errors="replace")

    @property
    def dropped_events(self) -> int:
        """Cumulative event count discarded because the event queue was full."""

        return self._dropped_events

    @property
    def dropped_callbacks(self) -> int:
        """Cumulative callback count discarded because its queue was full."""

        return self._dropped_callbacks

    @property
    def last_event_sequence(self) -> int | None:
        """Highest domain-event sequence returned to the consumer."""

        return self._last_event_sequence

    @property
    def observed_event_sequence(self) -> int | None:
        """Highest domain-event sequence read from stdout (not a safe cursor)."""

        return self._last_received_sequence

    @property
    def callback_error_count(self) -> int:
        return self._callback_error_count

    def command(self) -> tuple[str, ...]:
        """Return the command that will be launched, without secrets or env."""

        if self._command_override is not None:
            return self._command_override
        args = [self.node_path, str(self.bin_path), "serve"]
        if self.project_cwd is not None:
            args.extend(("--cwd", str(self.project_cwd)))
        if self.data_dir is not None:
            args.extend(("--data-dir", str(self.data_dir)))
        if self.model is not None:
            args.extend(("--model", self.model))
        if self.mcp_config is not None:
            args.extend(("--mcp-config", str(self.mcp_config)))
        if self.events_enabled:
            args.append("--events")
        if self.events_after is not None:
            args.extend(("--events-after", str(self.events_after)))
        return tuple(args)

    async def start(self) -> "OrchestratorClient":
        """Start the persistent child once and return this client."""

        async with self._lifecycle_lock:
            if self._closed:
                raise self._terminal_error or BridgeClosedError("orchestrator bridge is closed")
            if self._process is not None:
                return self
            if self._started:
                raise self._terminal_error or BridgeClosedError("orchestrator bridge failed to start")

            command = self.command()
            environment = None
            if self._env_override is not None:
                environment = os.environ.copy()
                environment.update(self._env_override)

            kwargs: dict[str, Any] = {
                "stdin": asyncio.subprocess.PIPE,
                "stdout": asyncio.subprocess.PIPE,
                "stderr": asyncio.subprocess.PIPE,
                # This is a stream-reader limit, not a request/event queue.
                "limit": self._max_line_bytes + 1,
            }
            if self.launch_cwd is not None:
                kwargs["cwd"] = str(self.launch_cwd)
            if environment is not None:
                kwargs["env"] = environment
            # A new process group on Windows helps Node keep its own child
            # runtime separate.  Shutdown still targets only this exact child.
            if os.name == "nt":
                creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                if creation_flags:
                    kwargs["creationflags"] = creation_flags

            try:
                self._process = await asyncio.create_subprocess_exec(*command, **kwargs)
            except Exception as exc:
                self._started = True
                self._closed = True
                error = BridgeClosedError("could not start orchestrator serve process")
                self._terminal_error = error
                raise error from exc

            self._started = True
            self._reader_task = asyncio.create_task(self._read_stdout(), name="orchestrator-stdout")
            self._stderr_task = asyncio.create_task(self._read_stderr(), name="orchestrator-stderr")
            if self._event_callback is not None:
                self._callback_task = asyncio.create_task(self._run_callbacks(), name="orchestrator-events")
            return self

    async def __aenter__(self) -> "OrchestratorClient":
        return await self.start()

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        await self.close()

    async def request(
        self,
        method: str,
        params: Mapping[str, JsonValue] | None = None,
        *,
        timeout: float | None = None,
    ) -> JsonValue:
        """Send one request and await only its matching response.

        Timeout and caller cancellation remove this wait from the pending map
        but intentionally do not cancel work inside the orchestrator.  For a
        running turn, use the protocol's ``thread.cancel`` method when the
        operation itself must stop.
        """

        if not isinstance(method, str) or not method:
            raise ValueError("method must be a non-empty string")
        await self.start()
        process = self._process
        if process is None or process.stdin is None or self._closed:
            raise self._terminal_error or BridgeClosedError("orchestrator bridge is closed")

        request_id = str(self._next_id)
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[JsonValue] = loop.create_future()
        pending = _PendingRequest(method=method, future=future)
        self._pending[request_id] = pending
        payload = {"id": request_id, "method": method, "params": dict(params or {})}

        try:
            encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            async with self._write_lock:
                if self._closed or process.stdin.is_closing():
                    raise self._terminal_error or BridgeClosedError("orchestrator bridge is closed")
                process.stdin.write(encoded)
                await process.stdin.drain()
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            future.cancel()
            raise
        except (TypeError, ValueError):
            self._pending.pop(request_id, None)
            future.cancel()
            raise
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            self._pending.pop(request_id, None)
            future.cancel()
            error = BridgeClosedError("orchestrator serve stdin closed")
            await self._mark_closed(error)
            raise error from exc

        try:
            if timeout is None:
                return await future
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            future.cancel()
            raise
        except asyncio.CancelledError:
            self._pending.pop(request_id, None)
            future.cancel()
            raise

    async def next_event(self, *, timeout: float | None = None) -> JsonValue:
        """Return the next event, or a drop marker requiring state resync."""

        if not self._started:
            await self.start()
        if self._dropped_since_marker:
            count = self._dropped_since_marker
            self._dropped_since_marker = 0
            marker: dict[str, JsonValue] = {
                "type": "events.dropped",
                "dropped": count,
                "resyncRequired": True,
            }
            if self._resync_after_sequence is not None:
                marker["resyncAfterSequence"] = self._resync_after_sequence
            if self._last_event_sequence is not None:
                marker["lastEventSequence"] = self._last_event_sequence
            self._resync_after_sequence = None
            return marker

        if self._closed and self._event_queue.empty():
            raise self._terminal_error or BridgeClosedError("orchestrator bridge is closed")

        try:
            if timeout is None:
                item = await self._event_queue.get()
            else:
                item = await asyncio.wait_for(self._event_queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            raise
        if item is _EVENT_END:
            raise self._terminal_error or BridgeClosedError("orchestrator bridge is closed")
        sequence = self._event_sequence(item)
        if sequence is not None and (self._last_event_sequence is None or sequence > self._last_event_sequence):
            self._last_event_sequence = sequence
        return item

    async def iter_events(self) -> AsyncIterator[JsonValue]:
        """Yield events until the owned process closes.

        The iterator ends on process shutdown so websocket forwarding tasks can
        finish naturally.  Direct callers that need to distinguish EOF from a
        clean close should use :meth:`next_event` instead.
        """

        while True:
            try:
                yield await self.next_event()
            except BridgeClosedError:
                return

    async def close(self, *, timeout: float = 5.0) -> None:
        """Stop only this client's process and release all waiters."""

        async with self._lifecycle_lock:
            if self._closed and self._process is None:
                return
            self._closing = True
            close_error = BridgeClosedError("orchestrator bridge closed")
            await self._mark_closed(close_error, terminate=False)
            process = self._process
            if process is None:
                self._cancel_background_tasks()
                return

            if process.stdin is not None and not process.stdin.is_closing():
                process.stdin.close()
                wait_closed = getattr(process.stdin, "wait_closed", None)
                if wait_closed is not None:
                    try:
                        await asyncio.wait_for(wait_closed(), timeout=min(1.0, max(timeout, 0.0)))
                    except (BrokenPipeError, ConnectionError, OSError):
                        pass
                    except asyncio.TimeoutError:
                        pass

            try:
                await asyncio.wait_for(process.wait(), timeout=max(timeout, 0.0))
            except asyncio.TimeoutError:
                # terminate()/kill() apply to this exact subprocess object;
                # never issue a shell or process-name-wide kill.
                if process.returncode is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=min(1.0, max(timeout, 0.0)))
                except asyncio.TimeoutError:
                    if process.returncode is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                    await asyncio.gather(process.wait(), return_exceptions=True)
            finally:
                await self._finish_background_tasks()

    async def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                try:
                    line = await process.stdout.readline()
                except asyncio.LimitOverrunError as exc:
                    raise BridgeProtocolError("orchestrator response line exceeded the configured limit") from exc
                if not line:
                    if not self._closing:
                        return await self._mark_closed(BridgeEOFError("orchestrator serve process reached EOF"))
                    return
                if len(line) > self._max_line_bytes:
                    raise BridgeProtocolError("orchestrator response line exceeded the configured limit")
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    message = json.loads(stripped.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    # Do not echo the line: protocol output may contain user
                    # content or credentials.
                    raise BridgeProtocolError("orchestrator emitted invalid JSON") from exc
                await self._handle_message(message)
        except asyncio.CancelledError:
            raise
        except BridgeClosedError as exc:
            await self._mark_closed(exc)
        except Exception as exc:
            await self._mark_closed(BridgeProtocolError("orchestrator response reader failed"))
            # Keep the original exception attached for task diagnostics only;
            # it is never sent to the application response or logs here.
            if self._terminal_error is not None:
                self._terminal_error.__cause__ = exc

    async def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            while True:
                chunk = await process.stderr.read(4096)
                if not chunk:
                    return
                self._append_stderr(chunk)
        except asyncio.CancelledError:
            raise
        except (BrokenPipeError, ConnectionError, OSError):
            return

    async def _handle_message(self, message: JsonValue) -> None:
        if not isinstance(message, dict):
            raise BridgeProtocolError("orchestrator emitted a non-object message")
        if message.get("method") == "event":
            self._enqueue_event(message.get("params", {}))
            return
        if "id" not in message:
            raise BridgeProtocolError("orchestrator response did not include an id")
        request_id = str(message["id"])
        pending = self._pending.pop(request_id, None)
        # A late response to a timed-out/cancelled request is safe to ignore.
        if pending is None:
            return
        if "error" in message:
            pending.future.set_exception(OrchestratorRequestError(pending.method, request_id, message["error"]))
        else:
            pending.future.set_result(message.get("result"))

    def _enqueue_event(self, event: JsonValue) -> None:
        if self._closed:
            return
        sequence = self._event_sequence(event)
        if sequence is not None:
            previous = self._last_received_sequence
            if previous is None or sequence > previous:
                self._last_received_sequence = sequence
        if self._event_queue.full():
            try:
                self._event_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._dropped_events += 1
            self._dropped_since_marker += 1
            # The safe replay cursor is the last event the application has
            # actually consumed. Do not advance it to a received/buffered
            # event when the queue overflows.
            if self._resync_after_sequence is None:
                self._resync_after_sequence = self._last_event_sequence
        self._event_queue.put_nowait(event)

        if self._event_callback is not None:
            if self._callback_queue.full():
                try:
                    self._callback_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                self._dropped_callbacks += 1
            self._callback_queue.put_nowait(event)

    @staticmethod
    def _event_sequence(event: JsonValue) -> int | None:
        if not isinstance(event, dict):
            return None
        sequence = event.get("sequence")
        return sequence if isinstance(sequence, int) and not isinstance(sequence, bool) and sequence >= 0 else None

    async def _run_callbacks(self) -> None:
        while True:
            item = await self._callback_queue.get()
            if item is _EVENT_END:
                return
            callback = self._event_callback
            if callback is None:
                return
            try:
                result = callback(item)
                if inspect.isawaitable(result):
                    await result
            except asyncio.CancelledError:
                raise
            except Exception:
                # Callback failures must not take down the protocol reader.
                self._callback_error_count += 1

    async def _mark_closed(self, error: BridgeClosedError, *, terminate: bool = True) -> None:
        if self._terminal_error is None or not self._closing:
            self._terminal_error = error
        self._closed = True
        self._fail_pending(self._terminal_error or error)
        self._signal_end(self._event_queue)
        self._signal_end(self._callback_queue)
        if terminate:
            process = self._process
            if process is not None and process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass

    def _fail_pending(self, error: BaseException) -> None:
        pending = tuple(self._pending.values())
        self._pending.clear()
        for request in pending:
            if not request.future.done():
                request.future.set_exception(error)

    def _signal_end(self, queue: asyncio.Queue[JsonValue | object]) -> None:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            queue.put_nowait(_EVENT_END)
        except asyncio.QueueFull:
            pass

    def _append_stderr(self, chunk: bytes) -> None:
        if not self._stderr_tail_limit:
            return
        if len(chunk) >= self._stderr_tail_limit:
            chunk = chunk[-self._stderr_tail_limit :]
            self._stderr_chunks.clear()
            self._stderr_size = 0
        self._stderr_chunks.append(chunk)
        self._stderr_size += len(chunk)
        while self._stderr_size > self._stderr_tail_limit and self._stderr_chunks:
            removed = self._stderr_chunks.popleft()
            self._stderr_size -= len(removed)

    def _cancel_background_tasks(self) -> None:
        for task in (self._reader_task, self._stderr_task, self._callback_task):
            if task is not None and not task.done():
                task.cancel()

    async def _finish_background_tasks(self) -> None:
        current = asyncio.current_task()
        tasks = [
            task
            for task in (self._reader_task, self._stderr_task, self._callback_task)
            if task is not None and task is not current
        ]
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


__all__ = [
    "BridgeClosedError",
    "BridgeEOFError",
    "BridgeError",
    "BridgeProtocolError",
    "OrchestratorClient",
    "OrchestratorRequestError",
]
