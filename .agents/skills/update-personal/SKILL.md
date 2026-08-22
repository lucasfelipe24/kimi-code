---
name: update-personal
description: Use when the user asks to pull/sync upstream changes into their fork — e.g. "atualiza a personal", "traz o upstream", "update personal". Fetches upstream, fast-forwards local `main`, merges `main` into `personal`, resolves conflicts, and reports what is new. Does not push unless explicitly told to.
---

# Update Personal

Sync this fork with the upstream repo: bring upstream commits into local `main`, then merge `main` into the `personal` working branch, then tell the user what changed.

## Repo layout (fixed for this fork)

- `origin` → the personal fork (`github.com/lucasfelipe24/kimi-code`).
- `upstream` → the source repo (`github.com/MoonshotAI/kimi-code`).
- `main` → tracks `origin/main` but mirrors upstream content; kept as a clean mirror (no fork-only commits normally).
- `personal` → the working branch with all fork-only work (workflows, plugins, web-search, persistent memory, CI, etc.). This is where the user lives.

## Procedure

1. **Check state first.** Run `git status` and `git branch -vv`. The working tree must be clean before merging — if it is dirty, stop and tell the user; do not stash or discard their work without asking.

2. **Ensure the `upstream` remote exists** (it is not always configured on a fresh clone):
   ```bash
   git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/MoonshotAI/kimi-code.git
   ```

3. **Fetch both remotes.**
   ```bash
   git fetch upstream --prune
   git fetch origin --prune
   ```

4. **Update `main` from upstream.** Prefer a fast-forward — `main` should have no commits of its own:
   ```bash
   git checkout main
   git merge --ff-only upstream/main
   ```
   If `--ff-only` fails, `main` has diverged (someone committed to it directly). Stop and show the user `git log --oneline upstream/main..main` before doing anything else — do not force or rebase without asking.

5. **Merge `main` into `personal`.**
   ```bash
   git checkout personal
   git merge main --no-edit
   ```

6. **Resolve conflicts if any.** List them with `git diff --name-only --diff-filter=U`. Conflicts tend to concentrate where the fork's customizations sit next to upstream code that changed — check first the fork's feature areas (workflows, web-search, persistent memory, CI/workflows files) and the docs config tables (`docs/en/configuration/`, `docs/zh/configuration/`). Rule of thumb:
   - **Keep** the fork-only lines (features that only exist in this fork, e.g. workflow/web-search/persistent-memory code and config).
   - **Adopt** upstream's wording for lines that exist on both sides.
   - When unsure whether a hunk is fork-only or a genuine semantic change, read both sides and ask rather than guessing.
   After editing, verify no markers remain: `grep -rn '<<<<<<<\|>>>>>>>\|=======' <files>`, then `git add` them and `git commit --no-edit` to finish the merge.

7. **Confirm clean state.** `git status` should report a clean tree; `git log --oneline -3` should show the merge commit on top.

## Do NOT push

Leave everything local. Report the ahead-counts (`main` vs `origin/main`, `personal` vs `origin/personal`) and let the user decide. Only run `git push` when they explicitly ask.

## Report what is new

Summarize the upstream commits that landed, grouped by impact, in the user's language (Portuguese by default here). For each, give the commit hash, the one-line subject, and a plain sentence on what it actually changes — read the diffstat or the commit body when the subject is opaque. Call out anything that touches code the fork customizes (agent-core-v2 refactors, kap-server protocol/snapshot moves, TUI, web-search, workflows), since those are the likely build breakers.

Use `git log --oneline --no-decorate <old-main>..upstream/main` (captured before step 4) to enumerate exactly what came in.

## After a big merge

If the upstream batch touched code the fork patches, suggest running a typecheck/build (`pnpm typecheck`, which builds the packages first) before the user pushes — but only run it if they say yes. Do not generate a changeset for a plain sync merge.
