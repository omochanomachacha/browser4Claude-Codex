# vendor: agent-browser snapshot ref logic

- source repository: https://github.com/vercel-labs/agent-browser
- pinned commit: `03a8cb95d07627a34981670060c8472d723e6cfe`
- vendored files:
  - `ref_formatter.ts` (adapted deterministic ref assignment)
  - `snapshot.ts` (upstream reference implementation for snapshot options/filters)

This directory intentionally vendors only pure snapshot/ref formatting logic.
Browser I/O and CDP transport stay in this project (`src/daemon`, `extension`).
