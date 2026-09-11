import { describe, it, expect } from 'vitest';
import { fileEditorRootFor, fileFinderRootFor, flowRunPaneIsOnScreen } from './fileEditorRoot';

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

describe('fileFinderRootFor', () => {
  const CONV_ROOT = '/Users/x/git/overcli';

  it('indexes the run, not the conversation left selected underneath', () => {
    expect(
      fileFinderRootFor({
        detailMode: 'flows',
        explorerRootPath: null,
        runProjectPath: RUN_ROOT,
        workerFilesRoot: null,
        conversationRoot: CONV_ROOT,
      }),
    ).toBe(RUN_ROOT);
  });

  it('indexes the worker desk with no run open', () => {
    expect(
      fileFinderRootFor({
        detailMode: 'workers',
        explorerRootPath: null,
        runProjectPath: null,
        workerFilesRoot: WORKER_ROOT,
        conversationRoot: CONV_ROOT,
      }),
    ).toBe(WORKER_ROOT);
  });

  it('lets an open explorer win over everything', () => {
    expect(
      fileFinderRootFor({
        detailMode: 'flows',
        explorerRootPath: '/Users/x/git/other',
        runProjectPath: RUN_ROOT,
        workerFilesRoot: WORKER_ROOT,
        conversationRoot: CONV_ROOT,
      }),
    ).toBe('/Users/x/git/other');
  });

  it('falls back to the conversation root in a chat', () => {
    expect(
      fileFinderRootFor({
        detailMode: 'conversation',
        explorerRootPath: null,
        runProjectPath: RUN_ROOT,
        workerFilesRoot: WORKER_ROOT,
        conversationRoot: CONV_ROOT,
      }),
    ).toBe(CONV_ROOT);
  });

  it('has nothing to index with no place on screen', () => {
    expect(
      fileFinderRootFor({
        detailMode: 'stats',
        explorerRootPath: null,
        runProjectPath: null,
        workerFilesRoot: null,
        conversationRoot: null,
      }),
    ).toBeNull();
  });
});
