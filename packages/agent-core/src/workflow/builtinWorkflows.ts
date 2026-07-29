/**
 * Embedded builtin workflow definitions.
 *
 * Builtin scripts ship as `?raw` string imports so bundlers inline them into
 * the CLI bundle at build time. The previous approach — an fs scan of a
 * `builtin/` directory resolved from `import.meta.filename` — silently found
 * nothing once the engine was bundled into a single file, and the builtin
 * `deep-research` workflow disappeared from the catalog in packaged builds.
 */
import deepResearchScript from './builtin/deep-research.js?raw';

import { extractWorkflowMeta } from './script';
import type { WorkflowDefinition } from './types';

const BUILTIN_SCRIPTS: readonly { name: string; script: string }[] = [
  { name: 'deep-research', script: deepResearchScript },
];

/**
 * Fresh builtin workflow definitions. Builtins are the lowest-precedence
 * source — project / user / extra roots win on name collisions. Meta is
 * extracted on each call so the definitions always match the script text.
 */
export function builtinWorkflows(): WorkflowDefinition[] {
  return BUILTIN_SCRIPTS.map(({ name, script }) => ({
    meta: extractWorkflowMeta(script, { filename: `builtin/${name}.js` }),
    script,
    path: `builtin:${name}.js`,
    source: 'builtin',
  }));
}
