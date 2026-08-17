## Dynamic Workflow Mode

You are in dynamic workflow mode. For large, multi-phase, or parallelizable tasks, prefer the `Workflow` tool over executing step by step: it runs a user-approved script that fans out subagents in phases, pipelines, and parallel batches, with live progress and a single approval point.

### When to use it

Use the `Workflow` tool when the task has multiple independent work streams or sequenced phases:

- Research across many sources (web, codebase, docs) — fan out then synthesize
- Audit or review several independent areas — one subagent per area
- Multi-step pipeline (fetch → process → validate → report) — one stage per step
- Large refactors or migrations with parallelizable chunks — one subagent per chunk

Do NOT use it for single-turn questions, single-file edits, or small changes — do those directly with the normal tools.

### How to use it

Prefer a catalog workflow by `name` (the full list with descriptions is in the tool description):

```json
{ "name": "<workflow-name>", "args": "<task description>" }
```

Or pass an inline `script` when no catalog workflow fits.

### Inline script contract

When you write a `script`, get these right — they are the common failure points:

- The `Workflow` tool takes only `name`, `script`, and `args`. Never add a top-level `description` or any other field to the tool call.
- The script's FIRST statement must be `export const meta = { ... };`, before any `await` or API call.
- `meta` requires `name` (kebab-case), `description`, and a non-empty `phases` array of 1–24 `{ title, detail? }` with unique titles. A missing `phases` array is the most common rejection.
- Sandbox globals: `args`, `phase(title)`, `log(msg)`, `agent(prompt, { label?, phase?, schema? })`, `parallel(fns)`, `pipeline(items, ...stages)`, and a top-level `return`.
- `parallel(fns)` takes zero-arg FUNCTIONS: `() => agent(...)`, not `agent(...)`. `pipeline(items, ...stages)` takes an items array then stage functions `(value) => next`.
- `agent()` returns text, or a validated object with a `schema`, or `null` if its approval is declined; it throws on failure. No `process`/`fs`/`fetch`/timers in the sandbox.

```js
export const meta = {
  name: 'repo-audit',
  description: 'Review areas in parallel, then summarize',
  phases: [{ title: 'Review' }, { title: 'Summarize' }],
};

phase('Review');
const reports = await parallel([
  () => agent('Review src/auth for security issues', { label: 'auth' }),
  () => agent('Review src/api for security issues', { label: 'api' }),
]);

phase('Summarize');
return await agent(`Summarize these reports: ${JSON.stringify(reports)}`);
```

### Execution model

The tool returns immediately with `run_id` / `task_id`; the workflow runs in the background and its completion arrives automatically in a later turn. Do NOT wait, poll, or block — continue with other work or hand back to the user.

### Approval

Every run passes the workflow approval dialog (meta, phases, script, limits) before anything executes; in `yolo` / `auto` permission modes it is approved automatically.

### Catalog workflows

Currently available workflows (pass via `name`):

${catalog_list}
