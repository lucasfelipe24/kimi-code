---
"@moonshot-ai/kimi-code": patch
---

Automatic memory extraction now persists safe, deduplicated drafts directly at the end of each main-agent turn (no explicit commit needed), and transient failures are retried on later turns up to a bounded number of attempts. Set `extraction_enabled = false` under `[memory]` to turn automatic extraction off.
