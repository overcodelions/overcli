import { describe, it, expect } from 'vitest';
import { fileEditorRootFor, flowRunPaneIsOnScreen } from './fileEditorRoot';

const WORKER_ROOT = '/Users/x/Library/Application Support/overcli/workers/w1';
const RUN_ROOT = '/Users/x/Library/Application Support/overcli/workspaces/abc';

describe('fileEditorRootFor', () => {
  it('uses the run root in the flows tab', () => {
    expect(
      fileEditorRootFor({
        detailMode: 'flows',
        runProjectPath: RUN_ROOT,
        workerFilesRoot: null,
      }),
    ).toBe(RUN_ROOT);
  });

  it('uses the run root for a run opened inside a worker', () => {
    expect(
      fileEditorRootFor({
        detailMode: 'workers',
        runProjectPath: RUN_ROOT,
        workerFilesRoot: WORKER_ROOT,
      }),
    ).toBe(RUN_ROOT);
  });

  it('falls back to the worker directory with no run open', () => {
    expect(
      fileEditorRootFor({
        detailMode: 'workers',
        runProjectPath: null,
        workerFilesRoot: WORKER_ROOT,
      }),
    ).toBe(WORKER_ROOT);
  });

  it('leaves the conversation root alone elsewhere', () => {
    expect(
      fileEditorRootFor({
        detailMode: 'conversation',
        runProjectPath: RUN_ROOT,
        workerFilesRoot: WORKER_ROOT,
      }),
    ).toBeNull();
  });
});

describe('flowRunPaneIsOnScreen', () => {
  it('covers both views that render a run', () => {
    expect(flowRunPaneIsOnScreen('flows')).toBe(true);
    expect(flowRunPaneIsOnScreen('workers')).toBe(true);
  });

  it('excludes views that do not', () => {
    expect(flowRunPaneIsOnScreen('conversation')).toBe(false);
    expect(flowRunPaneIsOnScreen('explorer')).toBe(false);
  });
});
