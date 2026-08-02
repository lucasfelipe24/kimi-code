/**
 * `persistentMemory` domain — best-effort credential redaction + a quarantine
 * detector for persisted memory text.
 *
 * Shared, dependency-free helper reused by every write surface: the `Memory`
 * tool (Phase 2) and the automatic extraction service (Phase 5), which runs it
 * over the transcript-derived text before it ever reaches the generation model
 * or the store.
 *
 * SECURITY BOUNDARY (read before changing):
 *  - This is a BEST-EFFORT, deny-list redactor for well-known CREDENTIAL shapes
 *    (PEM keys, GitHub/Slack/AWS/Google/OpenAI-style tokens, bearer/basic auth,
 *    `key=…`/`token=…`/`password=…` assignments, JWTs, cookies). It is NOT an
 *    entropy scanner and it does NOT (deliberately) touch emails, URLs, or file
 *    paths — those are frequently LEGITIMATE memory content (a project's repo
 *    URL, a config path, a contact) and blanket-redacting them would corrupt
 *    useful memory. Do not add email/URL/path redaction here.
 *  - Because the deny-list is incomplete, `looksLikeSecret` is the fail-safe:
 *    callers that persist untrusted, model-derived drafts (extraction) run it
 *    AFTER redaction and QUARANTINE (reject) any draft that still looks like it
 *    carries a credential, rather than persisting silently. Quarantine biases
 *    toward dropping a borderline memory over leaking a secret.
 *
 * Pure functions — no DI, no IO. Scope-agnostic (lives under App).
 */

const REDACTED = '[redacted]';

/**
 * Ordered credential deny-list. Each entry either fully replaces the match with
 * `[redacted]` or (for labeled assignments/headers) keeps the label and redacts
 * the value, so the shape stays readable while the secret is gone.
 */
const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key blocks (any flavor).
  [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
    REDACTED,
  ],
  // `Authorization: Bearer <token>` / `Authorization: Basic <token>`.
  [/\b(authorization)\s*:\s*(bearer|basic)\s+\S+/gi, `$1: $2 ${REDACTED}`],
  // Set-Cookie / Cookie headers.
  [/\b(set-cookie|cookie)\s*:\s*\S+/gi, `$1: ${REDACTED}`],
  // `api_key=… / token=… / secret=… / password=… / access_token=…` assignments.
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
    `$1=${REDACTED}`,
  ],
  // OpenAI-style `sk-…` / `pk-…` / `ak-…` keys (incl. project keys `sk-proj-…`).
  [/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // GitHub tokens: classic `ghp_/gho_/ghu_/ghs_/ghr_` and fine-grained PATs.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  // Slack tokens (`xoxb-/xoxp-/…`) and Slack webhook URLs.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, REDACTED],
  // AWS access-key id and 40-char secret access key.
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\baws_secret_access_key\b\s*[:=]\s*\S+/gi, `aws_secret_access_key=${REDACTED}`],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  // Stripe / SendGrid / npm style prefixed keys.
  [/\b(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, REDACTED],
  // JWT `eyJ….….…` triplets.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED],
];

/**
 * Best-effort credential redaction for a persisted memory string field (body,
 * name, or description) or for transcript-derived text handed to extraction.
 * Deny-list only — see the module SECURITY BOUNDARY note. Does not touch
 * emails/URLs/paths.
 */
export function redactMemoryBody(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTION_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Fail-safe quarantine detector. Returns `true` when `value` STILL looks like it
 * carries a credential after redaction — used to REJECT a model-proposed draft
 * rather than persist it. Deliberately conservative on the "leak" side: it fires
 * on a residual PEM header, any of the known token prefixes, an
 * `Authorization`/secret-assignment shape, or a long high-entropy base64-ish
 * blob (mixed case + digits, length ≥ 32 — excludes plain hex like a git SHA to
 * avoid quarantining legitimate content). It is NOT a proof of safety; it is a
 * second gate on top of `redactMemoryBody`.
 */
export function looksLikeSecret(value: string): boolean {
  if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(value)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/.test(value)) return true;
  if (/\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(value)) return true;
  if (/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/.test(value)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(value)) return true;
  if (/\bAIza[0-9A-Za-z_-]{35}\b/.test(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return true;
  // A residual `Authorization: Bearer/Basic <token>` header with a real value.
  if (/\bauthorization\s*:\s*(?:bearer|basic)\s+(?!\[redacted\])\S/i.test(value)) return true;
  // A residual secret ASSIGNMENT (`label: value` / `label=value`) with a real
  // (non-redacted) value. This gate runs over already-redacted text, so the
  // negative lookahead skips the `label=[redacted]` marker `redactMemoryBody`
  // leaves behind — it fires only on a value redaction somehow missed. The
  // separator is mandatory so the check can't match the separator char itself.
  if (
    /\b(?:aws_secret_access_key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd)\b\s*[:=]\s*(?!\[redacted\])[^\s[]/i.test(
      value,
    )
  ) {
    return true;
  }
  // High-entropy base64-ish blob: mixed-case letters AND digits, length ≥ 32. A
  // pure hex run (e.g. a 40-char git SHA) or single-case word is intentionally
  // NOT matched, to avoid quarantining legitimate content.
  for (const token of value.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []) {
    const isPlainHex = /^[0-9a-fA-F]+$/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (!isPlainHex && hasLower && hasUpper && hasDigit) return true;
  }
  return false;
}
