# Third-party notices

`packages/core/`, `packages/contracts/`, `packages/shared/`, and T3-derived code in `test-support/` contain source from the public [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit `17c0878941ab8ab19108fb639c5138d92a89e919`. That source is distributed under the MIT license, Copyright (c) 2026 T3 Tools Inc. The full notice is preserved in [LICENSE](LICENSE).

The local composition, Copilot SDK adapter, CLI/NDJSON host, browser adapters, and Python integration examples are project-specific additions. They do not require a T3 checkout or T3 runtime data at execution time.

The local provider adapter depends on `@github/copilot-sdk` 1.0.33 and its bundled runtime. Dependency and runtime licenses remain with their respective packages. Runtime binaries are installed through npm rather than copied into this repository.

`packages/chat-renderer/src/upstream/` contains T3's HTML rendering protocol, bootstrap, and theme palettes under the T3 MIT notice. The browser adapters use Marked (MIT), DOMPurify (Apache-2.0 OR MPL-2.0), Lowlight (MIT), and Highlight.js (BSD-3-Clause). The renderer build includes the dependency license texts in its generated notices.
