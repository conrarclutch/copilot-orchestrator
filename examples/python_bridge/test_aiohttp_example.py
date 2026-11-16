"""Security-boundary tests for the optional aiohttp adapter."""

from __future__ import annotations

import unittest

try:
    from .aiohttp_example import BROWSER_RPC_ALLOWLIST, browser_rpc_allowed, install_orchestrator
except ImportError:  # pragma: no cover
    from aiohttp_example import BROWSER_RPC_ALLOWLIST, browser_rpc_allowed, install_orchestrator  # type: ignore[no-redef]


class AiohttpBoundaryTests(unittest.TestCase):
    def test_browser_allowlist_excludes_local_path_operations(self) -> None:
        self.assertIn("project.list", BROWSER_RPC_ALLOWLIST)
        self.assertIn("thread.send", BROWSER_RPC_ALLOWLIST)
        self.assertNotIn("project.create", BROWSER_RPC_ALLOWLIST)
        self.assertNotIn("worktree.create", BROWSER_RPC_ALLOWLIST)
        self.assertNotIn("attachment.import", BROWSER_RPC_ALLOWLIST)
        self.assertTrue(browser_rpc_allowed("thread.create", {"projectId": "p"}))
        self.assertFalse(browser_rpc_allowed("thread.create", {"worktreePath": "C:/sensitive"}))
        self.assertFalse(browser_rpc_allowed("attachment.import", {"path": "C:/sensitive"}))

    def test_route_install_requires_explicit_authorization_callback(self) -> None:
        with self.assertRaisesRegex(ValueError, "authorize callback is required"):
            install_orchestrator(object())


if __name__ == "__main__":
    unittest.main()
