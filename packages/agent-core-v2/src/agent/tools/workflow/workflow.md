Run a dynamic workflow: a user-approved JavaScript script that orchestrates subagents in phases (parallel fan-out, pipelines, JSON-schema structured output) to complete multi-step work such as deep research.

Provide EITHER `name` (a workflow from the catalog, discovered from the project, user, extra, or builtin roots) OR `script` (an inline workflow script) — exactly one, never both, never neither. `args` is an optional string handed to the script as its `args` value. There are no other parameters; do not pass a top-level `description`, `phases`, or any field besides `name`, `script`, and `args`.

The workflow runs in the background and returns immediately with a run id and a task id. Its completion arrives automatically as a notification in a later turn — do NOT wait, poll, or block on it; continue with other work or hand back to the user. Use TaskOutput with the task id only if the user explicitly asks for intermediate progress.

Prefer `name` over inline `script` when a suitable catalog workflow exists (e.g. the builtin `deep-research` workflow for multi-source fact-checked research). Write an inline `script` only when no catalog workflow fits; keep scripts small and prefer composing `agent()`, `parallel()`, and `pipeline()` over long sequential chains.

## Writing an inline `script`

A script is an ES module whose FIRST significant statement is `export const meta = { ... };`, followed by a top-level async body (top-level `await` allowed) that ends with a top-level `return` of a JSON-serializable result. `meta` must appear before any `await` or API call, or compilation fails.

`meta` fields:

- `name` (required): kebab-case, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64 chars.
- `description` (required): non-empty, max 500 chars.
- `phases` (required): array of 1–24 `{ title, detail? }` objects; every `title` must be non-empty and unique. This is the single most common omission — a missing or empty `phases` array is rejected before the run starts.
- `whenToUse` (optional), `argumentHint` (optional, max 200 chars).

Sandbox globals available in the body (these names are reserved — do not redeclare them):

- `args`: the argument string passed at invocation (the tool's `args`).
- `phase(title)`: mark the current phase; `title` must be a non-empty string and should match one of `meta.phases[].title`.
- `log(message)`: append a line to the run log (coerced to string, truncated at 2000 chars).
- `agent(prompt, opts?)`: run ONE subagent. `prompt` must be a non-empty string. `opts` is an optional object `{ label?: string, phase?: string, schema?: object }`. Returns the subagent's text; with a `schema` (a JSON Schema object) it returns a validated, parsed object instead; returns `null` if the subagent's approval is declined; throws on failure or if the output does not match the schema.
- `parallel(fns)`: `fns` is an array of zero-arg FUNCTIONS (thunks), run concurrently; resolves to an array of their results. Pass `() => agent(...)`, NOT `agent(...)` — passing already-started promises is rejected.
- `pipeline(items, ...stages)`: `items` is an ARRAY; the rest are stage FUNCTIONS `(value) => next`. Each item flows through the stages in order (no barrier between items); a stage returning `null`/`undefined` skips the remaining stages for that item.
- `return <value>`: end the run; the value must be JSON-serializable.

The sandbox is a restricted `node:vm` context: no `process`, `require`, `fs`, `fetch`, timers, `console`, or `Buffer`, and `eval`/`Function` are disabled. Standard built-ins (`JSON`, `Math`, `Date`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `structuredClone`, …) are available.

Runs are bounded by resolved limits: `max_concurrency` (default 4) caps how many subagents run at once, `max_agent_calls` (default 50) caps total `agent()` calls (exceeding it aborts the run), and a wall-clock duration ceiling applies.

Minimal example:

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
