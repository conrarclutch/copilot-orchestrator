# Synthetic browser-query benchmark

Compares Playwright, Puppeteer and direct Chrome DevTools Protocol (CDP) in a single isolated, headless Edge process. It never opens enterprise sites, reads personal profiles or uses credentials. This measures automation overhead, not CrowdStrike/Entra query latency.

## Reproduce

Requires Node 24+ and an installed Chromium-based browser. From this directory:

```powershell
npm ci
npm run benchmark
```

Edge is detected at common Windows installation paths. Set `BROWSER_EXECUTABLE_PATH` if necessary. For a second saved run:

```powershell
$env:BENCHMARK_OUTPUT = 'RESULTS-repeat.json'
npm run benchmark
```

The browser uses a unique empty profile under the repository's ignored `.orchestrator/browser-benchmark-profiles/` directory. Only the browser process created by the harness is closed. Generated profiles are retained; no recursive cleanup or existing-user-profile access is performed.

## Method

- One browser process per run, with all three clients attached over CDP and independent pages at the same viewport.
- A `data:` page with a query box, Run button and deterministic 100-row, five-column result table.
- Identical JavaScript invocation for query submission, readiness check and batched DOM extraction: three sequential browser evaluations per cycle.
- Five discarded warmups, then 40 measured trials per client in seeded randomized order.
- Every cycle checks the complete returned data against the expected rows. Failures stop the run.
- A separate Playwright technique experiment compares a single batched extraction against 100 per-row evaluations. Its two variants are interleaved; query submission and readiness are included in both.

The fixture renders synchronously. It does not model server processing, network delay, tenant policy, authentication, Monaco editors, browser locator auto-waits, screenshots, or model decisions. This uses Node.js bindings and Playwright's CDP attachment mode; it is not a benchmark of Python Playwright or Playwright's native launch transport. Viewport/desktop visibility and other workloads can change the results.

## Recorded observations

Two successful runs used Edge 157.0.4341.46, Node 24.18.1, Playwright 1.65.1 and Puppeteer 25.17.0 on Windows x64. Each client has 80 measured trials across those runs.

| Warm synthetic query cycle | Median | p95 |
| --- | ---: | ---: |
| Playwright | 12.07 ms | 23.58 ms |
| Puppeteer | 7.53 ms | 19.65 ms |
| Direct CDP | 7.19 ms | 14.68 ms |

| Playwright extraction technique, including query cycle | Median | p95 |
| --- | ---: | ---: |
| Batched | 9.41 ms | 12.85 ms |
| Row by row | 82.46 ms | 143.37 ms |

The roughly 8.8x batching improvement applies only to this synthetic workload. The library comparison saved roughly 5 ms at the median, which does not establish a meaningful improvement for a remotely executed investigation query.

Raw samples are in `recorded-run-1.json` and `recorded-run-2.json`; aggregate statistics and limitations are in `measured-summary.json`. These are observations from this computer, not expected performance on another machine. Browser startup and connection timings in the raw files are individual observations, not statistically ranked startup benchmarks.

Practical next experiment on the work computer: compare the current connector against a persistent browser session with batched extraction, using the same read-only query, tenant, time range and result-equivalence checks. A portal-supported in-session read request can also be tested where available. Keep backend query time separate from browser overhead.
