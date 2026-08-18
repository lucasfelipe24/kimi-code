import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { TOWER_FLAG_ID } from './tower';

export const TOWER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TOWER';

export const towerFlag: FlagDefinitionInput = {
  id: TOWER_FLAG_ID,
  title: 'Tower multi-agent orchestration',
  description:
    'Mission planning with worker/reviewer agents in git worktrees, the inbox protocol, and the /tower skill.',
  env: TOWER_FLAG_ENV,
  default: true,
  surface: 'both',
};

registerFlagDefinition(towerFlag);
