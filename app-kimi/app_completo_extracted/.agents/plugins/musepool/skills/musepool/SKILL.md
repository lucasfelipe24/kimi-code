---
name: musepool
description: >
  Use this skill whenever the user is creating a website, web page, web app, dashboard, portfolio, or any HTML-based output where design and variety matter. Use it before generating the artifact to avoid default AI aesthetics.
---

When an LLM decides design details on its own, it falls back to the average of what it has seen. The result is visually homogeneous and technically shallow. Musepool counters this by retrieving design precedents first.

Two operations, freely combined:

- **recall** (`--axis`) — Search candidates by dimension and return shallow summaries. Cast a wide net.
- **fetch** (`--ids` or `--query`) — Go deep. Fetch full seed records and selected dimensional references.

## Environment

Run inside the plugin root directory. The main script is `scripts/muse_tool.py`.

## Setup

Before the first use, ensure the dependencies (agent-gw SDK 0.2.6 or newer, and PyYAML) are installed. This checks the current environment and installs or upgrades only when needed:

```bash
python3 scripts/muse_tool.py ensure-deps
```

The script never touches credentials or gateway URLs itself: the `agent_gw` SDK reads the API key from `KIMI_API_KEY` or `~/.kimi/agent-gw.json`, and the endpoint from `KIMI_BASE_URL` / the same config file's `base_url` / the SDK default — always as a pair from the same environment. For local development against a non-default gateway, put that gateway's `base_url` and its matching `api_key` together in `~/.kimi/agent-gw.json`; never override only one of them.

## Usage

```bash
python3 scripts/muse_tool.py recall --axis '<field>=<n>[@temp]:"<query>"'
python3 scripts/muse_tool.py fetch  --ids a,b --fields seed,reference --ref-dim color,motion
```

## Principle: Search before designing

An LLM cannot avoid regressing to generic defaults through willpower alone. The antidote is external reference.

Before searching, do not fix colors, motion, layout, or typography. This step is only for understanding what the user actually needs — explicit requirements plus implicit constraints. You may decide which dimensions matter most (color? motion? layout? typography?), but do not decide the answers within those dimensions. The answers come from the references.

Surprise and variety come from broad search, not from what you imagine.

## Default traps to avoid

These are the cheapest defaults models fall back to. They are not wrong in isolation; they are overused. Real references do not look like this, so if you follow references, you avoid them:

- **Muddy palettes**: blue-purple gradients, fintech default blues, Tailwind defaults, glassmorphism + pastel borders, rainbow gradients as decoration.
- **Icon containers**: emoji, Font Awesome in colored rounded squares. Better: plain text, hand-drawn inline SVG, or well-chosen imagery.
- **Meaningless motion**: image hover zoom/rotate, fade-in-up, hover scale-105, loading spinners, scroll-triggered reveals for no reason, marquees.
- **Card nesting**: cards inside cards inside cards. Use spacing, weight, and dividers instead.
- **Border + radius + accent strip**: combined decorative frames, top/left accent bars, shadow under buttons that muddy the background.
- **Template copy**: centered hero + two CTAs + three equal feature cards, three-tier pricing with the middle highlighted, floating support widget, "modern and elegant", "clean and intuitive", empty "powerful", executive-summary bullets, emoji bullets.
- **Formulaic fonts**: using the same display typeface as a default signal of elegance or tech. Follow the reference's exact weight and size pairings instead.

## Engineering hard rules

- **Fonts must render the text on the page.** If the page contains Chinese, the font stack must explicitly include Chinese fonts. Do not render Chinese titles with pure Latin display fonts (Dela Gothic One, Bebas, Anton); Chinese will fall back to the system default and break cohesion. For mixed Latin/Chinese: `'LatinDisplay', 'ChineseFont', sans-serif`. System fonts (`-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`) are the safest. If using Google Fonts for Chinese, use `font-display: swap`.
- **Avoid italic for Chinese.** Chinese has no true italic. `font-style: italic` produces a mechanically slanted pseudo-italic that harms readability. For emphasis in Chinese, use weight, color, background highlight, size, tracking, or font family change (Kai/Song). If Latin italics are needed, scope them to a Latin-only `@font-face`.
- **Images: code-drawn or external, choose consciously.** Image-led outputs usually need images, but a bad image is worse than none. Options: (1) code-drawn (SVG/canvas/WebGL/CSS) — controlled, no broken links, no misattribution; (2) external (e.g. Unsplash with verified URLs). Verify external images exist before using them. If nothing fits, leave the image out and use typography/space/color instead. Forbidden: blank image areas, mismatched low-quality images, low-precision code drawings.

## Workflow

Classic flow: **broad search → identify wow moment → deep fetch → synthesize**. Adapt to the task:

- **Need more ideas?** Run several broad searches at different temperatures without fetching deep.
- **Known direction?** Skip recall and `fetch --query "..."` directly.
- **Standard path:** broad search for candidates → fetch selected items for key dimensions.

Steps:

1. **Broad search.** Decide which dimensions matter (layout, color, motion, typography, density, craft, imagery). Search each with English queries. Use higher temperature (0.6–0.9) for experimental/brand work, lower (0.2–0.3) for corporate/product/SaaS. Keep total summaries under ~20. Do not design yet.
2. **Identify wow + choose dimensions.** Scan the summaries. Look for unexpected strong candidates (note any `seg=serendipity` items) and decide which dimensions to fetch deeply.
3. **Deep fetch.** Fetch the selected items. Use `--ref-dim` to fetch only the dimensions you need; omitting it fetches all dimensions and produces large output.
4. **Synthesize.** Combine the borrowed constraints into the final artifact (see Synthesis below).

## recall

Call: `python3 scripts/muse_tool.py recall --axis ...` from the plugin root. Output is YAML to stdout.

```
--axis <field>=<n>[@temp]:"<query>"   repeatable, each axis is independent
```

- `field`: `gist`, `moves`, or a lowercase dimension (`layout`, `color`, `motion`, `typography`, `components`, `imagery`, `material`, `craft`, `narrative`, `tech_stack`, `algorithms`).
- `n`: number of results, 3–6 is usually enough, hard cap 12.
- `@temp`: per-axis temperature 0–1.
- `query`: English search phrase.

Returns:
- `gist` axis → `{short_id, seg, gist}`
- dimension axis → `{short_id, seg, <dim>_brief, has_ref}`
- `moves` axis → `{short_id, seg, moves}`

`seg=anchor` means high relevance; `seg=serendipity` means a random surprise. `has_ref=true` means that dimension has a written reference worth fetching.

### Temperature

Higher = more random/surprising. Lower = closer to query. Creative/brand/experimental tasks run hot (0.6–0.9); corporate/product/SaaS run cool (0.2–0.3). The global default is 0.3 (`--temp`). Early broad searches benefit from high temperature — variety comes from here.

## fetch

Fetch by ids or by query. During synthesis, keep to **at most 3 seeds + 5 dimensional references**; focus on 1–2 wow dimensions. Hard cap is 8 ids; exceeding 8 truncates with a warning. Prefer `--ref-dim` to keep output small.

```bash
# By id: seed + selected dimensional references (preferred, smallest)
python3 scripts/muse_tool.py fetch --ids lu5Uim0F,ipKbn3bs --fields seed,reference --ref-dim color,motion
# By id: full seed only
python3 scripts/muse_tool.py fetch --ids lu5Uim0F,ipKbn3bs --fields seed
# By query: skip recall when you already know the direction
python3 scripts/muse_tool.py fetch --query "generative canvas noise field" --count 2 --fields seed,reference --ref-dim algorithms,imagery
```

`--fields`: `gist`, `seed`, `reference`, `tags`. Default is `seed`.
`--ref-dim`: comma-separated dimensions to fetch.

Discipline: fetch both the **full seed** (global anchor) and the **key dimensional references** (depth). Seed without dimension loses craft; dimension without seed loses global structure.

## Writing queries

Queries are in English and determine recall quality.

1. **Search by problem, not style.** Write "number/time/readable/density/hierarchy", not "editorial/card-grid/neon/dark-theme/retro".
2. **Use task-specific words.** Generic words like `scroll`, `hover`, `minimal`, `grid` appear in every query; add words unique to this task (botanical/foliage, glitch/scanline, ink/brush-stroke).
3. **Keep hard constraints from the user.** Explicit color, theme, font family, or required information stays in the query as a requirement, not an abstract domain.
4. **Same-domain + cross-domain.** Search the literal task domain for strong examples, and structurally similar domains for lateral ideas. Diversity comes from multiple queries + high temperature, not from banning same-domain results.

## Synthesis — combine, don't mutate

The artifact borrows concrete constraints from the pool and combines them. It is not a memory-based mutation.

**Two hard rules:**

1. **Color must come from references.** Main colors (background, accent, text) must derive from references; do not invent them. Semantic colors not present in references (muted/status/multi-series/theme variants) should be derived from the reference palette (same temperature, saturation, lightness ladder), not invented.
2. **Implementation must not be downgraded.** Build what the reference builds. Do not replace a reference's technique, material, structure, or motion with a simpler version to save effort. Detail is value; losing detail loses quality.

**Selection discipline:** One surprising layout decision, one unexpected palette, or one obsessively crafted micro-interaction is worth more than three safe correct references. Choose fewer, choose better.

**Minimum adaptation:** Use the reference's method with the user's content. Swap in the user's text, images, and scenario; preserve the reference's layout, color, typography, motion, and material. Neither copy the reference's content nor invent techniques the reference does not use.

## Output rules

- Do not paste raw reference content into the final answer.
- Do not mention where the references came from.
- Do not reveal any internal ids, short_ids, or search parameters.
- Do not state "based on reference X" or "inspired by source Y".
- Present the design decisions as your own synthesis of the user's requirements.
- If the retrieved items are not suitable, change the search query and search again. Do not force-fit poor matches.
