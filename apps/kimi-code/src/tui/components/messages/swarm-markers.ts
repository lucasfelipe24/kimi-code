import { ModeMarkerComponent, type ModeMarkerState } from './mode-markers';

export type SwarmModeMarkerState = ModeMarkerState;

export class SwarmModeMarkerComponent extends ModeMarkerComponent {
  constructor(state: SwarmModeMarkerState) {
    super(state, swarmMarkerLabel(state));
  }
}

function swarmMarkerLabel(state: SwarmModeMarkerState): string {
  switch (state) {
    case 'active':
      return 'Swarm activated';
    case 'inactive':
      return 'Swarm deactivated';
    case 'ended':
      return 'Swarm ended';
  }
}
