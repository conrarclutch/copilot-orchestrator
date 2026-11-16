"""Isolated transport tests using a fake owned NDJSON child process."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest

try:  # Support both package execution and unittest discovery from this folder.
    from .client import (
        BridgeClosedError,
        BridgeEOFError,
        BridgeProtocolError,
        OrchestratorClient,
        OrchestratorRequestError,
    )
except ImportError:  # pragma: no cover
    from client import (  # type: ignore[no-redef]
        BridgeClosedError,
        BridgeEOFError,
        BridgeProtocolError,
        OrchestratorClient,
        OrchestratorRequestError,
    )


FAKE_SERVER = r'''
import json
import sys
import time

for raw in sys.stdin:
    message = json.loads(raw)
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if method == "sleep":
        time.sleep(float(params.get("seconds", 0.05)))
        print(json.dumps({"id": request_id, "result": {"slept": True}}), flush=True)
    elif method == "echo":
        print(json.dumps({"id": request_id, "result": params}), flush=True)
    elif method == "error":
        print(json.dumps({"id": request_id, "error": {"code": "fake_failure", "detail": "not logged"}}), flush=True)
    elif method == "emit_many":
        for sequence in range(1, int(params.get("count", 1)) + 1):
            print(json.dumps({"method": "event", "params": {"sequence": sequence, "kind": "tick"}}), flush=True)
        print(json.dumps({"id": request_id, "result": {"emitted": int(params.get("count", 1))}}), flush=True)
    elif method == "emit_gap":
        for sequence in (1, 3):
            print(json.dumps({"method": "event", "params": {"sequence": sequence, "kind": "gap"}}), flush=True)
        print(json.dumps({"id": request_id, "result": {"emitted": 2}}), flush=True)
    elif method == "stderr":
        sys.stderr.write("token-like diagnostic tail that must stay bounded\n")
        sys.stderr.flush()
        print(json.dumps({"id": request_id, "result": True}), flush=True)
    elif method == "malformed":
        print("not-json", flush=True)
    elif method == "eof":
        sys.exit(0)
    else:
        print(json.dumps({"id": request_id, "result": {"method": method}}), flush=True)
'''


class OrchestratorClientTests(unittest.IsolatedAsyncioTestCase):
    def make_client(self, **options: object) -> OrchestratorClient:
        options.setdefault("event_queue_size", 16)
        return OrchestratorClient(command=[sys.executable, "-u", "-c", FAKE_SERVER], **options)

    async def test_multiplexed_responses_match_request_ids(self) -> None:
        client = self.make_client()
        try:
            results = await asyncio.gather(
                *(client.request("echo", {"index": index}) for index in range(12))
            )
            self.assertEqual([result["index"] for result in results], list(range(12)))
            self.assertTrue(client.running)
        finally:
            await client.close()

    async def test_error_response_is_structured_without_echoing_payload(self) -> None:
        client = self.make_client()
        try:
            with self.assertRaises(OrchestratorRequestError) as raised:
                await client.request("error", {"sensitive": "do-not-log"})
            self.assertEqual(raised.exception.error["code"], "fake_failure")
            self.assertNotIn("do-not-log", str(raised.exception))
        finally:
            await client.close()

    async def test_timeout_and_cancellation_leave_persistent_host_usable(self) -> None:
        client = self.make_client()
        try:
            with self.assertRaises(asyncio.TimeoutError):
                await client.request("sleep", {"seconds": 0.04}, timeout=0.001)
            cancelled = asyncio.create_task(client.request("sleep", {"seconds": 0.04}))
            await asyncio.sleep(0.001)
            cancelled.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled
            await asyncio.sleep(0.09)
            result = await client.request("echo", {"alive": True})
            self.assertEqual(result, {"alive": True})
        finally:
            await client.close()

    async def test_eof_fails_waiter_and_closes_bridge(self) -> None:
        client = self.make_client()
        with self.assertRaises(BridgeEOFError):
            await client.request("eof")
        self.assertTrue(client.closed)
        await client.close()

    async def test_protocol_error_fails_waiter_without_raw_line(self) -> None:
        client = self.make_client()
        try:
            with self.assertRaises(BridgeProtocolError):
                await client.request("malformed", {"secret": "not returned"})
            self.assertNotIn("not returned", str(client._terminal_error))  # noqa: SLF001 - transport assertion
        finally:
            await client.close()

    async def test_bounded_event_queue_emits_drop_marker_and_resync_cursor(self) -> None:
        client = self.make_client(event_queue_size=2, events_after=0)
        try:
            await client.request("emit_many", {"count": 5})
            marker = await client.next_event()
            self.assertEqual(marker["type"], "events.dropped")
            self.assertEqual(marker["dropped"], 3)
            self.assertTrue(marker["resyncRequired"])
            self.assertEqual(marker["resyncAfterSequence"], 0)
            self.assertEqual(marker["lastEventSequence"], 0)
            self.assertEqual(client.dropped_events, 3)
            self.assertEqual((await client.next_event())["sequence"], 4)
            self.assertEqual((await client.next_event())["sequence"], 5)
            self.assertEqual(client.last_event_sequence, 5)
        finally:
            await client.close()

    async def test_noncontiguous_monotonic_sequences_are_valid(self) -> None:
        client = self.make_client(event_queue_size=8, events_after=0)
        try:
            await client.request("emit_gap")
            self.assertEqual((await client.next_event())["sequence"], 1)
            self.assertEqual((await client.next_event())["sequence"], 3)
            self.assertEqual(client.last_event_sequence, 3)
        finally:
            await client.close()

    async def test_stderr_tail_is_bounded(self) -> None:
        client = self.make_client(stderr_tail_bytes=12)
        try:
            await client.request("stderr")
            self.assertLessEqual(len(client.stderr_tail.encode("utf-8")), 12)
        finally:
            await client.close()

    async def test_slow_callback_cannot_block_response_reader(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def callback(_: object) -> None:
            started.set()
            await release.wait()

        client = self.make_client(event_queue_size=2, event_callback=callback)
        try:
            result = await client.request("emit_many", {"count": 20})
            self.assertEqual(result["emitted"], 20)
            await asyncio.wait_for(started.wait(), timeout=1)
            self.assertGreater(client.dropped_callbacks, 0)
        finally:
            release.set()
            await client.close()

    async def test_default_command_exposes_mcp_config_and_event_cursor(self) -> None:
        client = OrchestratorClient(mcp_config="mcp.json", events_after=17)
        command = client.command()
        self.assertIn("--mcp-config", command)
        self.assertIn("mcp.json", command)
        self.assertIn(("--events-after"), command)
        self.assertIn("17", command)

    async def test_close_releases_pending_waiter(self) -> None:
        client = self.make_client()
        try:
            pending = asyncio.create_task(client.request("sleep", {"seconds": 10}))
            await asyncio.sleep(0.01)
            await client.close(timeout=0.1)
            with self.assertRaises(BridgeClosedError):
                await pending
        finally:
            await client.close()

    async def test_close_before_start_is_terminal(self) -> None:
        client = self.make_client()
        await client.close()
        with self.assertRaises(BridgeClosedError):
            await client.start()


if __name__ == "__main__":
    unittest.main()
