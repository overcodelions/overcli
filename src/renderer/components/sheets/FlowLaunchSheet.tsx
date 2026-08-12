// Standalone flow launcher, for launching from outside the Flows pane —
// today the ⌘K palette. Thin wrapper: it resolves the flow id and wires the
// launcher's exits to the sheet host. All the UI (prompt composer, target
// picker, worktree controls) is the same `FlowRunLauncher` the Flows
// library uses, so a flow launched from ⌘K behaves identically.
//
// Rendered without sheet chrome — see BARE_SHEETS in SheetHost.

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { FlowRunLauncher } from '../flows/FlowLaunch';

export function FlowLaunchSheet({ flowId }: { flowId: string }) {
  const flows = useFlowsStore((s) => s.flows);
  const openSheet = useStore((s) => s.openSheet);
  const setDetailMode = useStore((s) => s.setDetailMode);

  const flow = flows.find((f) => f.id === flowId);
  // The flow was deleted or the library reloaded out from under us. Nothing
  // to launch, and a blank modal is worse than none.
  if (!flow) return null;

  return (
    <FlowRunLauncher
      flow={flow}
      onClose={() => openSheet(null)}
      onLaunched={() => {
        openSheet(null);
        setDetailMode('flows');
      }}
    />
  );
}
