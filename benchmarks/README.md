# Benchmarks

## Aider Polyglot — 2026-06-03

**222 / 225 (98.7%)** on the [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark) — 225 Exercism exercises across C++, Go, Java, JavaScript, Python, and Rust.

| | |
|---|---|
| Model | `grok-code-fast-1` (xAI) |
| Score | **222 / 225 (98.7%)** |
| Cost | **$24.91 total** (~$0.11 / task) |
| AutoCode build | [`81176e6`](https://github.com/BVRAI/AutoCode/commit/81176e6) |

### By language

| Language | Pass | |
|---|---|---|
| Go | 39 / 39 | 100% |
| Java | 47 / 47 | 100% |
| Rust | 30 / 30 | 100% |
| JavaScript | 48 / 49 | 98% |
| Python | 33 / 34 | 97% |
| C++ | 25 / 26 | 96% |

The three misses are genuine model failures (a planning loop, two logic errors), not harness errors — the harness discriminates rather than rubber-stamping.

### Methodology

Agentic and test-driven. AutoCode writes a solution, runs the exercise's own unit tests, reads the failures, and iterates until they pass — bounded by a per-task **cost budget** (greedy decoding, temperature 0), not a step cap. This is the *agentic-harness* setup and is distinct from Aider's 2-try leaderboard format, so it is comparable to other agentic harnesses rather than to the 2-try model leaderboard.

Integrity: each sandbox has the exercise's reference solution and hints (`.meta` / `.docs` / `.approaches`) stripped, and web tools are disabled — the agent solves from the problem statement plus the provided tests only.

### The receipt

[`aider-polyglot-2026-06-03.json`](./aider-polyglot-2026-06-03.json) — the full machine-readable record: every task's pass/fail, cost, duration, the exact test command, and test-output tails. It records the AutoCode commit (`81176e6`) it ran against, so the result is tied to a verifiable build.
