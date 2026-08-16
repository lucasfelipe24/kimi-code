---
'@moonshot-ai/kimi-code': minor
---

Add the `[visual_model]` config section to pin a vision-capable companion model for media inspection — with it set, a text-only main model keeps `ReadMediaFile` (inspecting through the visual model) and pasted media degrades to a text hint instead of failing. Set `model` in `config.toml` (or `KIMI_VISUAL_MODEL`); `default_effort` (or `KIMI_VISUAL_EFFORT`) sets its thinking effort.
