import { useStore } from '../store';
import { SettingsSheet } from './sheets/SettingsSheet';
import { DebugSheet } from './sheets/DebugSheet';
import { AboutSheet } from './sheets/AboutSheet';
import { CapabilitiesSheet } from './sheets/CapabilitiesSheet';
import { NewAgentSheet } from './sheets/NewAgentSheet';
import { NewWorkspaceSheet } from './sheets/NewWorkspaceSheet';
import { EditWorkspaceSheet } from './sheets/EditWorkspaceSheet';
import { NewWorkspaceAgentSheet } from './sheets/NewWorkspaceAgentSheet';
import { NewColosseumSheet } from './sheets/NewColosseumSheet';
import { ColosseumCompareSheet } from './sheets/ColosseumCompareSheet';
import { FileFinderSheet } from './sheets/FileFinderSheet';
import { QuickSwitcherSheet } from './sheets/QuickSwitcherSheet';
import { ShortcutsHelpSheet } from './sheets/ShortcutsHelpSheet';
import { WorktreeDiffSheet } from './sheets/WorktreeDiffSheet';
import { ProjectDiffSheet } from './sheets/ProjectDiffSheet';
import { WorkspaceAgentReviewSheet } from './sheets/WorkspaceAgentReviewSheet';
import { ArchiveConversationSheet } from './sheets/ArchiveConversationSheet';
import { ArchiveAllSheet } from './sheets/ArchiveAllSheet';
import { BulkConversationActionsSheet } from './sheets/BulkConversationActionsSheet';

/// The diff sheets need much more horizontal room than everything else
/// (sidebar + full-width diff body), so we widen the container frame
/// based on sheet type. Anything else keeps the default 680px shell.
const WIDE_SHEETS = new Set<string>([
  'worktreeDiff',
  'projectDiff',
  'workspaceAgentReview',
  'colosseumCompare',
  'bulkConversationActions',
]);

export function SheetHost() {
  const sheet = useStore((s) => s.activeSheet);
  const close = useStore((s) => s.openSheet);
  if (!sheet) return null;
  const wide = WIDE_SHEETS.has(sheet.type);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => close(null)}
    >
      <div
        className={
          'bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full overflow-hidden flex flex-col ' +
          // Wide sheets (diff viewers, colosseum compare, bulk actions)
          // get a fixed height/width so the frame doesn't snap between
          // tall and short whenever the diff under-fills it. Narrow
          // sheets keep `max-h` since their content varies more
          // legitimately (a short About vs. a long Settings).
          (wide ? 'max-w-[1240px] h-[88vh]' : 'max-w-[680px] max-h-[80vh]')
        }
        onClick={(e) => e.stopPropagation()}
      >
        {sheet.type === 'settings' && <SettingsSheet />}
        {sheet.type === 'debug' && <DebugSheet />}
        {sheet.type === 'about' && <AboutSheet />}
        {sheet.type === 'capabilities' && <CapabilitiesSheet />}
        {sheet.type === 'newAgent' && <NewAgentSheet projectId={sheet.projectId} />}
        {sheet.type === 'newWorkspace' && <NewWorkspaceSheet />}
        {sheet.type === 'editWorkspace' && <EditWorkspaceSheet workspaceId={sheet.workspaceId} />}
        {sheet.type === 'newWorkspaceAgent' && (
          <NewWorkspaceAgentSheet workspaceId={sheet.workspaceId} />
        )}
        {sheet.type === 'newColosseum' && <NewColosseumSheet projectId={sheet.projectId} />}
        {sheet.type === 'colosseumCompare' && <ColosseumCompareSheet colosseumId={sheet.colosseumId} />}
        {sheet.type === 'worktreeDiff' && <WorktreeDiffSheet convId={sheet.convId} />}
        {sheet.type === 'projectDiff' && <ProjectDiffSheet convId={sheet.convId} />}
        {sheet.type === 'workspaceAgentReview' && (
          <WorkspaceAgentReviewSheet coordinatorId={sheet.coordinatorId} />
        )}
        {sheet.type === 'archiveConversation' && (
          <ArchiveConversationSheet convId={sheet.convId} />
        )}
        {sheet.type === 'archiveAllInProject' && (
          <ArchiveAllSheet projectId={sheet.projectId} />
        )}
        {sheet.type === 'archiveAllInWorkspace' && (
          <ArchiveAllSheet workspaceId={sheet.workspaceId} />
        )}
        {sheet.type === 'bulkConversationActions' && <BulkConversationActionsSheet />}
        {sheet.type === 'fileFinder' && <FileFinderSheet rootPath={sheet.rootPath} />}
        {sheet.type === 'quickSwitcher' && <QuickSwitcherSheet />}
        {sheet.type === 'shortcutsHelp' && <ShortcutsHelpSheet />}
      </div>
    </div>
  );
}
