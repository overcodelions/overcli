import { describe, expect, it } from 'vitest';
import { StreamEvent, TaskProgressInfo, ToolResultBlock } from '@shared/types';
import { finishedFromEvents, isBackgroundLaunch, subagentStatus } from './subagentStatus';

const launched: ToolResultBlock = {
  id: 't1',
  content: 'Async agent launched successfully.\nagentId: abc',
  isError: false,
};
const report: ToolResultBlock = { id: 't1', content: 'Here is what I found', isError: false };

function progress(phase: TaskProgressInfo['phase'], status?: string): TaskProgressInfo {
  return { taskId: 'k', toolUseId: 't1', phase, status };
}

function assistant(text: string, toolUses: string[] = []): StreamEvent {
  return {
    id: Math.random().toString(),
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: {
        model: null,
        text,
        thinking: [],
        toolUses: toolUses.map((name, i) => ({ id: `u${i}`, name, inputJSON: '{}' })),
      } as any,
    },
  };
}

describe('subagentStatus', () => {
  it('treats a foreground result as done', () => {
    expect(subagentStatus({ result: report, progress: undefined, events: [] })).toBe('done');
    expect(subagentStatus({ result: undefined, progress: undefined, events: [] })).toBe('running');
    expect(subagentStatus({ result: { ...report, isError: true }, progress: undefined, events: [] })).toBe('error');
  });

  it('does not take a background launch receipt as finished', () => {
    expect(isBackgroundLaunch(launched)).toBe(true);
    expect(subagentStatus({ result: launched, progress: progress('progress'), events: [] })).toBe('running');
    expect(subagentStatus({ result: launched, progress: progress('completed', 'completed'), events: [] })).toBe('done');
    expect(subagentStatus({ result: launched, progress: progress('completed', 'failed'), events: [] })).toBe('error');
  });

  it('reads a reopened background agent from its own transcript', () => {
    expect(subagentStatus({ result: launched, progress: undefined, events: [assistant('Final report.')] })).toBe('done');
    expect(subagentStatus({ result: launched, progress: undefined, events: [assistant('', ['Grep'])] })).toBe(
      'ranInBackground',
    );
  });
});

describe('finishedFromEvents', () => {
  it('is false while the last message still calls tools', () => {
    expect(finishedFromEvents([assistant('Done.'), assistant('', ['Read'])])).toBe(false);
    expect(finishedFromEvents([assistant('', ['Read']), assistant('Done.')])).toBe(true);
    expect(finishedFromEvents([])).toBe(false);
  });
});
