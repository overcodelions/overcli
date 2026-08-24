import { describe, it, expect, vi } from 'vitest';
import { sheetSubmitKeys } from './sheetSubmit';

function ev(over: Partial<Record<string, unknown>> = {}, tag = 'INPUT', type = 'text') {
  return {
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { tagName: tag, type },
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...over,
  } as any;
}

describe('sheetSubmitKeys', () => {
  it('submits on ⌘↵ and ⌃↵ from a textarea', () => {
    for (const mod of ['metaKey', 'ctrlKey']) {
      const submit = vi.fn();
      sheetSubmitKeys(submit)(ev({ [mod]: true }, 'TEXTAREA', ''));
      expect(submit).toHaveBeenCalled();
    }
  });

  it('submits on plain ↵ and ⇧↵ from a single-line field', () => {
    for (const e of [ev(), ev({ shiftKey: true })]) {
      const submit = vi.fn();
      sheetSubmitKeys(submit)(e);
      expect(submit).toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it('leaves ↵ alone in a textarea, on a button, and on a checkbox', () => {
    for (const e of [ev({}, 'TEXTAREA', ''), ev({}, 'BUTTON', ''), ev({}, 'INPUT', 'checkbox')]) {
      const submit = vi.fn();
      sheetSubmitKeys(submit)(e);
      expect(submit).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('ignores keys another handler already claimed, and IME composition', () => {
    for (const e of [ev({ defaultPrevented: true }), ev({ nativeEvent: { isComposing: true } })]) {
      const submit = vi.fn();
      sheetSubmitKeys(submit)(e);
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('ignores other keys and ⌥↵', () => {
    for (const e of [ev({ key: 'a' }), ev({ altKey: true, metaKey: true })]) {
      const submit = vi.fn();
      sheetSubmitKeys(submit)(e);
      expect(submit).not.toHaveBeenCalled();
    }
  });
});
