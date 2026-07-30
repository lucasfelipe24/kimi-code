import type { ModeMarkerState } from '../components/messages/mode-markers';

export function workflowMarkerLabel(state: ModeMarkerState): string {
  switch (state) {
    case 'active':
      return 'Dynamic Workflow activated';
    case 'inactive':
      return 'Dynamic Workflow deactivated';
    case 'ended':
      return 'Dynamic Workflow ended';
  }
}
