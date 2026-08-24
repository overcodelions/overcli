import type { KeyboardEvent } from 'react';

/// ↵ shortcuts for the create/edit sheets, bound on the sheet's outer div so
/// every field in the form gets them.
///
/// ⌘↵ (⌃↵ elsewhere) submits from anywhere — it is what the composer and the
/// file editor already use, so it is the chord people try first. ↵ and ⇧↵
/// submit too, but only from a single-line field, where ↵ has no other job:
/// inside a textarea both stay newline keys, and on a button or a combobox ↵
/// belongs to whatever has focus.
export function sheetSubmitKeys(submit: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.altKey) return;
    // A combobox picking its highlighted option, or anything else that has
    // already claimed this ↵.
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (!e.metaKey && !e.ctrlKey) {
      const el = e.target as HTMLElement | null;
      if (el?.tagName !== 'INPUT') return;
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio' || type === 'button') return;
    }
    e.preventDefault();
    submit();
  };
}
