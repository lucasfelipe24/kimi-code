/**
 * Pre-approved hosts for FetchURL auto-approval.
 *
 * ## ⚠️ SECURITY WARNING
 *
 * These domains are **only** pre-approved for FetchURL **GET** requests
 * (read-only content retrieval). They MUST NOT be used as a sandbox
 * network restriction — the sandbox enforces its own egress policy
 * independently. Granting auto-approval here does NOT bypass sandbox
 * network rules.
 *
 * Any addition to this list MUST be accompanied by a security review
 * confirming the domain exclusively hosts public, static documentation
 * or reference material.
 */

// ── Raw entries ────────────────────────────────────────────────────────

const PREAPPROVED_HOSTS = new Set([
  // ─── Kimi platforms ───
  'platform.kimi.com',
  'docs.kimi.com',

  // ─── Programming languages & standards ───
  'docs.python.org',
  'en.cppreference.com',
  'docs.oracle.com',
  'learn.microsoft.com',
  'developer.mozilla.org',
  'go.dev',
  'pkg.go.dev',
  'doc.rust-lang.org',
  'www.typescriptlang.org',
  'nodejs.org',
  'bun.sh',
  'www.php.net',
  'docs.swift.org',
  'kotlinlang.org',
  'ruby-doc.org',

  // ─── Frontend frameworks & tooling ───
  'react.dev',
  'angular.io',
  'vuejs.org',
  'nextjs.org',
  'expressjs.com',
  'tailwindcss.com',
  'jestjs.io',
  'webpack.js.org',
  'redux.js.org',

  // ─── Python / data ecosystem ───
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pandas.pydata.org',
  'numpy.org',
  'jupyter.org',

  // ─── ML / AI ───
  'www.tensorflow.org',
  'pytorch.org',
  'scikit-learn.org',
  'huggingface.co',

  // ─── Databases & APIs ───
  'www.postgresql.org',
  'dev.mysql.com',
  'redis.io',
  'www.mongodb.org',
  'www.sqlite.org',
  'prisma.io',
  'graphql.org',

  // ─── Cloud / infrastructure ───
  'docs.aws.amazon.com',
  'cloud.google.com',
  'kubernetes.io',
  'www.docker.com',
  'www.terraform.io',

  // ─── Vercel / Netlify docs (path-prefix) ───
  'vercel.com/docs',
  'docs.netlify.com',

  // ─── Git & GitHub ───
  'git-scm.com',
  'github.com/moonshot',

  // ─── Mobile ───
  'reactnative.dev',
  'docs.flutter.dev',
  'developer.apple.com',
  'developer.android.com',
]);

// ── Module-level split ─────────────────────────────────────────────────

/** Hostnames approved for any path (entries without `/`). */
const HOSTNAME_ONLY: ReadonlySet<string> = new Set();

/** Hostnames whose approval is scoped to specific path prefixes. */
const PATH_PREFIXES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slashIdx = entry.indexOf('/');
    if (slashIdx === -1) {
      (HOSTNAME_ONLY as Set<string>).add(entry);
    } else {
      const hostname = entry.slice(0, slashIdx);
      const prefix = entry.slice(slashIdx);
      const paths = map.get(hostname);
      if (paths) {
        paths.push(prefix);
      } else {
        map.set(hostname, [prefix]);
      }
    }
  }
  return map;
})();

// ── Exports ────────────────────────────────────────────────────────────

/**
 * Check whether a hostname + pathname combination is pre-approved.
 *
 * - Hostname-only entries match any path on that host (O(1) `Set.has`).
 * - Path-prefix entries enforce a segment boundary: `pathname === prefix`
 *   OR `pathname.startsWith(prefix + '/')` to prevent accidental partial
 *   segment matches.
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;

  const prefixes = PATH_PREFIXES.get(hostname);
  if (!prefixes) return false;

  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Parse a URL string and delegate to {@link isPreapprovedHost}.
 *
 * Returns `false` for any URL that cannot be parsed.
 */
export function isPreapprovedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return isPreapprovedHost(parsed.hostname, parsed.pathname);
}
