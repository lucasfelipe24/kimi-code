/**
 * `tower` domain — tower-mode context-injection provider.
 *
 * Re-emits the active tower protocol reminder at each new turn and after a
 * compaction rearm, including the authoritative Tower* tool set and the rule
 * that protocol state lives in `.tower/`. Bound at Agent scope through the
 * `tower` Feature.
 */

import { Service } from '#/_base/di/service';
import { createDecorator } from '#/_base/di/instantiation';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';

import { IAgentTowerService, TOWER_TOOL_NAMES } from './tower';

const TOWER_MODE_INJECTION_VARIANT = 'tower_mode';
const TOWER_MODE_REMINDER = [
  'Tower mode is active.',
  `For tower protocol actions, use only the Tower* tools: ${TOWER_TOOL_NAMES.join(', ')}.`,
  'Do not hallucinate protocol actions or edit .tower/ by hand; wire and roster state live in .tower/.',
].join('\n');

export interface IAgentTowerModeInjection {
  readonly _serviceBrand: undefined;
}

export const IAgentTowerModeInjection = createDecorator<IAgentTowerModeInjection>(
  'agentTowerModeInjection',
);

export class TowerModeInjection extends Service implements IAgentTowerModeInjection {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
  ) {
    super();
    this._register(
      injector.register(TOWER_MODE_INJECTION_VARIANT, ({ isNewTurn }) => {
        if (!isNewTurn || !this.tower.isActive) return undefined;
        return TOWER_MODE_REMINDER;
      }),
    );
  }
}
