// @vitest-environment jsdom
//
// Answering a question from the Today page is two calls in a fixed order:
// the answer goes in as a steer, THEN the run resumes — so the step that
// asked re-runs with the answer at the top of its prompt. Reversed, the step
// would re-run without it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnswerBox } from './NowSection';

const invoke = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  invoke.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function type(value: string) {
  const input = host.querySelector('input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('AnswerBox', () => {
  it('steers the answer in, then resumes the run', async () => {
    invoke.mockResolvedValue({ ok: true });
    act(() => root.render(<AnswerBox runId="run-1" />));
    type('Deploy only');
    await submit();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['flows:steerRun', 'flows:resumeRun']);
    expect(invoke.mock.calls[0][1]).toEqual({ runId: 'run-1', text: 'The user answered your question:\nDeploy only' });
    expect(host.querySelector('input')!.value).toBe('');
  });

  it('does not resume when the answer could not be delivered, and keeps what you typed', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: 'Run not found.' });
    act(() => root.render(<AnswerBox runId="run-1" />));
    type('Deploy only');
    await submit();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Run not found.');
    expect(host.querySelector('input')!.value).toBe('Deploy only');
  });
});
