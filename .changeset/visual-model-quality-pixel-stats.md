---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Image inspection via the configured visual model now reports exact pixel statistics — original dimensions, sampled distinct color count, dominant color in RGB and hex, flat/solid detection, and alpha usage — and delivers images at native resolution up to the model's byte budget instead of aggressive downsampling, with a stricter prompt requiring exact color values, verbatim text, and coordinates rather than approximate descriptions.
