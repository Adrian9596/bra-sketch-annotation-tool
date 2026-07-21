# scripts/

This directory holds two things: the project's **build & test tooling** and the
Harness **durable-layer** assets.

## Build & test tooling (project)

Node ESM scripts, invoked via `npm run <name>` (see `package.json`). The build
step is the important one — `app.js` is generated, never hand-edited.

- `build-app.mjs` — concatenate `src/*` (order from `source-parts.mjs`) + inline
  rule JSON → `app.js`.
- `source-parts.mjs` — the single manifest declaring bundle order/membership.
- `serve.mjs` / `static-server.mjs` — local dev server.
- `check.mjs` — rebuild + parse/wiring validation.
- Test suites: `auto-mode-smoke.mjs`, `golden-tests.mjs`, `accuracy-tests.mjs`,
  `invariant-tests.mjs`, `pom-contract-tests.mjs`, `pipeline-tests.mjs`,
  `junction-tests.mjs`, `learning-tests.mjs`,
  `evidence-tests.mjs`, `autosave-check.mjs`, `pom7-limitations.mjs`. See
  [`../TESTING.md`](../TESTING.md).
- `groundtruth/` — TD-labelled ground truth for `accuracy`.
- `golden/` — committed per-image baselines for `golden`.

## Harness durable layer

Operational records (intake, stories, traces, decisions, backlog, tool
registry) live in a local SQLite database `harness.db`, managed by the Rust
Harness CLI. The database is `.gitignore`d; the schema is version-controlled.

- `schema/*.sql` — version-controlled migrations applied by the CLI.
- `bin/harness-cli` — the CLI binary (not committed). Install it with the
  command in the repo [`../README.md`](../README.md#harness), then:

  ```sh
  scripts/bin/harness-cli init
  scripts/bin/harness-cli query matrix
  ```

Full CLI usage and the agent operating loop are in
[`../docs/HARNESS.md`](../docs/HARNESS.md).
