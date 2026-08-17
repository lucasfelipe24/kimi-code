# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. Keep the root `AGENTS.md` limited to hot-path rules: the project map, hard constraints, and workflow requirements — things every task needs to know.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## Project Map

- `apps/kimi-code`: the CLI / TUI application. It consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on `@moonshot-ai/agent-core`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).
- the browser web UI: **its source no longer lives in this repo.** It is developed in the code-app repo (`apps/web`) and shipped as the committed, prebuilt bundle `apps/kimi-code/dist-web` (gitignored, force-added), synced from code-app with `KIMI_CODE_REPO=<this checkout> pnpm run sync:web` — sync and commit the bundle in the same change whenever the web UI should ship differently. `apps/kimi-code/scripts/check-web-assets.mjs` guards packaging against a missing bundle. To hack on the web UI against this repo's server, run `pnpm dev:server` here and point code-app's `pnpm dev:web` at it via `KIMI_SERVER_URL`.
- `apps/vis`, `apps/vis/server`, `apps/vis/web`: visual debugging tools for sessions and replays.
- `apps/kimi-inspect`: web inspector for the kap-server `/api/v1/debug` RPC surface — workspace/session browser, per-session transcript chat, per-scope Service panels, and the DI unit inspection view. See `apps/kimi-inspect/AGENTS.md`.
- `packages/agent-core`: the unified agent engine, including Agent, Session, profile, skills, tools, plan, permission, background, records, the in-process DI service layer (`src/services/`), and other core capabilities. See `packages/agent-core/AGENTS.md`.
- `packages/agent-core-v2`: the DI × Scope agent engine (the v2 port behind kap-server). Four `LifecycleScope` tiers — `App` / `Workspace` / `Session` / `Agent` (`app/scopes.ts`) — plus the L3 unit layer (`Service`/`Fiber` units, collection contribution points, the Feature seam in `src/features/`); there is no App-level session lifecycle facade — callers compose `ISessionIndex` → `IWorkspaceLifecycleService.handlerFor` → the handler. See `packages/agent-core-v2/AGENTS.md` and use the `agent-core-dev` skill (`.agents/skills/agent-core-dev/SKILL.md`) when developing here.
- `packages/node-sdk`: the public TypeScript SDK and harness.
- `packages/kosong`: the LLM / provider abstraction layer.
- `packages/kaos`: the execution environment and file/process abstractions.
- `packages/oauth`: Kimi OAuth and managed auth utilities.
- `packages/telemetry`: shared client-side telemetry infrastructure.
- `packages/transcript`: the isomorphic transcript rendering data layer — L1 agent-granular store, L2 idempotent operations, L3 `off/turn/block/delta` subscription granularity, L4 framework-free view registry, plus turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports); the sole owner of the transcript contract types (`src/contract/`) and the op-batch sequencing contract. See `packages/transcript/AGENTS.md`.
- `packages/kap-server`: the Kimi Code server, backed by `@moonshot-ai/agent-core-v2`; exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`), plus the `/api/v1/debug/*` reflection RPC surface (`--debug-endpoints`, loopback bind + bearer auth). See `packages/kap-server/AGENTS.md`.
- `packages/klient`: the client SDK — a contract-driven facade over agent-core-v2 (`global.*` / `session(id).*` / `agent(id).*`, zod-validated); transport via subpath entry (`@moonshot-ai/klient/ipc|memory`, both return the same `Klient`); also hosts the e2e suites. See `packages/klient/AGENTS.md`.
- `packages/tree-sitter-bash`: a pure-TypeScript bash parser (no runtime deps, no wasm); `parse(source, { timeoutMs, maxNodes })` runs under a deterministic budget and returns a discriminated `ParseResult` — callers must treat aborted/hasError trees as "cannot analyze" and degrade. Parser only, no safety judgments; see the package README's "Known differences" section.
- `packages/minidb`: the embedded JSON document store (`MiniDb`) behind kap-server's search index — snapshot + WAL persistence with an exclusive write lock, a larger-than-RAM full-text layer, and persistent index generations. See `packages/minidb/AGENTS.md`.

## Environment Requirements

- **Node.js**: `>=24.15.0` (from the root `package.json` `engines`; `.nvmrc` is `24.15.0`, used by nvm / fnm / mise to pick the minimum recommended version).
- **pnpm**: `10.33.0` (from the root `package.json` `packageManager`).
- `pnpm install` will fail when the Node version is not satisfied, because `.npmrc` sets `engine-strict=true`.

## Tech Stack

- **Language**: TypeScript across the whole codebase (`tsconfig.json` targets `ES2024`, `module: preserve`, `moduleResolution: bundler`, `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `experimentalDecorators`). Type imports use `.ts` extensions (`allowImportingTsExtensions`); build never emits from the root config (`noEmit`).
- **Runtime**: Node.js ESM (`"type": "module"`). The CLI ships as a single self-contained executable (SEA) — see `apps/kimi-code/scripts/native/`.
- **Package manager**: pnpm workspaces (`pnpm-workspace.yaml`); shared `zod` version is pinned via the pnpm `catalog`.
- **Bundler / build tool**: `tsdown` per package; the CLI additionally bundles the web UI and native assets in its `build` script.
- **Lint**: `oxlint` (config `.oxlintrc.json`). **Format**: `oxfmt` (config `.oxfmtrc.json`).
- **Test**: `vitest` (root `vitest.config.ts`, projects = `packages/*`, `apps/kimi-code`, `apps/vscode`; v8 coverage).
- **UI stacks**: the TUI (`apps/kimi-code`) is built on `@moonshot-ai/pi-tui` + React (`react-jsx`); the browser web UI ships as the prebuilt `apps/kimi-code/dist-web` bundle (source lives in the code-app repo); the inspector tools (`apps/kimi-inspect`, `apps/vis/web`) use React/TSX.
- **Versioning / release**: `changesets` (`.changeset/`), `simple-git-hooks` + `lint-staged` on commit.

## Build, Test, and Lint Commands

Run all of these from the repo root unless noted. See `package.json` `scripts` for the full list.

- `pnpm install` — install workspace deps (fails if Node/pnpm version is unsatisfied; `engine-strict=true`).
- `pnpm build` — build every package (`pnpm -r run build`). `pnpm build:packages` builds only `packages/*`.
- `pnpm typecheck` — **builds packages first**, then runs `tsc --noEmit` across packages and the main apps. Not a cheap check.
- `pnpm lint` — `oxlint --type-aware`. `pnpm lint:fix` adds `--fix`.
- `pnpm test` — `vitest run` (all projects). `pnpm test:watch` and `pnpm test:coverage` are also available.
- `pnpm sherif` — validate monorepo dependency consistency.
- `pnpm dev:cli` — run the CLI in dev mode (`apps/kimi-code`). `pnpm dev:cli:legacy` runs it on the legacy engine (`KIMI_CODE_LEGACY_FLAG=1`).
- `pnpm dev:server` / `pnpm dev:kap-server` / `pnpm dev:v2` — run the server backend for the web/inspector clients (the web UI itself lives in the code-app repo).
- `pnpm dev:docs` — run the VitePress docs site (installs `docs/` with `--ignore-workspace`).
- Full release gate (`pnpm publish` script): `typecheck` → `lint` → `sherif` → `test` → `build` → `lint:pkg` → `changeset publish`. CI runs `lint`, `typecheck`, and `test` on every PR.
- Per-package commands via filters, e.g. `pnpm --filter @moonshot-ai/klient docker:e2e`, or `pnpm -C apps/kimi-code run e2e` (gated by `KIMI_E2E=1`).

## Monorepo Workspace Maintenance

- `pnpm-workspace.yaml` is the source of truth for workspace membership, but `flake.nix` also contains **hardcoded** `workspacePaths` and `workspaceNames` lists.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix` — for every package, including leaf / test / e2e packages that nothing depends on.**
  - `pnpm-workspace.yaml` uses globs (`packages/*`, `apps/*`), so most packages land there automatically; `flake.nix` is fully manual and is where omissions happen.
  - Missing a path in `flake.nix`'s `workspacePaths` will silently drop files from the Nix build's `src` fileset.
  - Missing a name in `flake.nix`'s `workspaceNames` will break `pnpmConfigHook` because dependencies for that workspace will not be fetched.
- The automated "Check flake.nix workspace sync" (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure (e.g. an e2e package nobody imports) slips through even when it is missing from `flake.nix`. A green check is therefore NOT proof that `flake.nix` is fully in sync — keep it updated by hand on every add/remove, do not rely on the check to catch omissions.

## General Coding Rules

- `packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones: no line/block comments; the exceptions are JSDoc attached to exported symbols and load-bearing lint-suppression directives (`oxlint-disable` / `eslint-disable`), while other tooling directives (`@ts-expect-error`, …) stay banned. Enforced by `scripts/check-no-comments.mjs`, which runs as part of `pnpm lint`.
- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, gated by the rule below.

## Code Style

- Formatting is enforced by `oxfmt` (`.oxfmtrc.json`): 100-char print width, 2-space indent, semicolons, single quotes, trailing commas everywhere, LF line endings, always-parenthesized arrow params. Imports are auto-sorted (builtin → external → internal → relative) and `package.json` keys sorted. Run `pnpm lint:fix` to apply.
- Lint is `oxlint` with `correctness` as errors and `suspicious`/`pedantic`/`perf` as warnings; plugins `typescript`, `import`, `unicorn`, `promise`, `node`. Notable enforced rules: `eqeqeq`, `no-misused-promises`, `only-throw-error`, `import/no-cycle`, `prefer-node-protocol`. Test files, `kosong/src/providers/**`, and the minidb worker closure have scoped rule relaxations (see `.oxlintrc.json` overrides).
- Prefer `import ... from '#/...'` (the per-package `imports` map, e.g. `apps/kimi-code`'s `#/*` → `./src/*.ts`) over deep relative paths.
- Use `node:`-prefixed builtins.

## Testing

- Tests run under `vitest`; the root `vitest.config.ts` registers `packages/*`, `apps/kimi-code`, and `apps/vscode` as projects and computes v8 coverage from `**/src/**/*.ts`.
- Co-locate tests as `*.test.ts` / `*.spec.ts` (also `.tsx`) or under a package's `test/` directory. `apps/kimi-code`'s own `test` script builds workspace packages first (`pnpm -w run build:packages`) before running vitest.
- Prefer adding cases to the existing test file for a component/module rather than creating new test files.
- e2e suites are gated behind env flags and a running server: `apps/kimi-code` uses `KIMI_E2E=1` / `KIMI_E2E_REAL=1`; `packages/klient` and `packages/server-e2e` run live suites against `KIMI_SERVER_URL` (default `http://127.0.0.1:58627`), with a docker runner in `packages/klient`. See each package's `AGENTS.md`.
- When a test fails after a user change, fix the test first unless the implementation is genuinely buggy.

## Security Considerations

- Never read, copy, or transmit secret files (`.env`, SSH private keys, credential stores). Stay within the working directory unless explicitly directed otherwise.
- The kap-server RPC surface (`/api/v1/debug/*`) reflects the entire DI registry with no whitelist; it is mounted only with `--debug-endpoints`, on a loopback bind, gated by global bearer auth. Do not widen this exposure.
- Workspaces carry a trust marker (`workspaceTrust`); while a workspace is untrusted, project-level `.mcp.json` / `.kimi-code/mcp.json` files are skipped. Preserve this gating when touching MCP config loading.
- In public text and test data, use neutral placeholders (`example.com`, `example.test`, `YOUR_API_KEY`) instead of real internal identifiers. Audit diffs before opening a PR.
- Report vulnerabilities via GitHub Security Advisories or `code@moonshot.ai` (see `SECURITY.md`), never a public issue.

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.
  - `packages/agent-core` (v1): add the flag to the central registry at `packages/agent-core/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`.
  - `packages/agent-core-v2` and kap-server modules: there is no central catalog — declare the flag in the owning domain via `registerFlagDefinition` at import time (see `packages/agent-core-v2/docs/flag.md`), then check it with `IFlagService.enabled(id)`. Current search-index-separation flags: `persistence_minidb_readmodel` (session read model, default on) and `search_worker` (global search worker host, default on).

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Project-map entries stay at 1–2 sentences; deep package docs live in the package's own `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, the PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill (see `.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- When generating a changeset, **never** decide on a `major` bump on your own — stop, explain, and get explicit user confirmation first; default to `minor`, fall back to `patch`. See `.agents/skills/gen-changesets/SKILL.md`.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.
