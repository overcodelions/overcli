import { useEffect, useRef } from 'react';
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// Tier 1: dedicated language packages (full Lezer parsers).
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { vue } from '@codemirror/lang-vue';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

// Tier 2: legacy stream modes for the long tail. Each is a tiny tokenizer,
// not a full parser, but the highlighting is still significantly better
// than the old hljs overlay + a real caret instead of a layered fake.
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { sCSS as sassMode, less as lessMode } from '@codemirror/legacy-modes/mode/css';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';

type HighlightRange = [number, number] | null;

/// Map our extension-derived language ids (see LANGUAGE_BY_EXT in
/// FileEditorPane) to a CodeMirror Extension. Unknown ids return [],
/// which is CM's idiomatic "no language" — the file still renders, just
/// without syntax colors (same fallback as before).
function languageExtension(id: string | null): Extension {
  if (!id) return [];
  switch (id) {
    // Tier 1 — full parsers
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'javascript':
      return javascript({ jsx: true });
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
    case 'java':
      return java();
    case 'cpp':
    case 'c':
      return cpp();
    case 'csharp':
      return cpp(); // close enough syntactically; no dedicated CM6 C# pkg
    case 'sql':
      return sql();
    case 'xml':
      return xml();
    case 'php':
      return php();
    case 'vue':
    case 'svelte':
      return vue();
    // Tier 2 — stream modes
    case 'bash':
      return new LanguageSupport(StreamLanguage.define(shell));
    case 'powershell':
      return new LanguageSupport(StreamLanguage.define(powerShell));
    case 'ruby':
      return new LanguageSupport(StreamLanguage.define(ruby));
    case 'perl':
      return new LanguageSupport(StreamLanguage.define(perl));
    case 'lua':
      return new LanguageSupport(StreamLanguage.define(lua));
    case 'swift':
      return new LanguageSupport(StreamLanguage.define(swift));
    case 'kotlin':
    case 'scala':
    case 'groovy':
      return new LanguageSupport(StreamLanguage.define(groovy));
    case 'ini':
      return new LanguageSupport(StreamLanguage.define(properties));
    case 'toml':
      return new LanguageSupport(StreamLanguage.define(toml));
    case 'dockerfile':
      return new LanguageSupport(StreamLanguage.define(dockerFile));
    case 'cmake':
      return new LanguageSupport(StreamLanguage.define(cmake));
    case 'makefile':
      return new LanguageSupport(StreamLanguage.define(shell)); // makefile recipes are shell-ish; close enough
    case 'r':
      return new LanguageSupport(StreamLanguage.define(r));
    case 'erlang':
      return new LanguageSupport(StreamLanguage.define(erlang));
    case 'haskell':
      return new LanguageSupport(StreamLanguage.define(haskell));
    case 'clojure':
      return new LanguageSupport(StreamLanguage.define(clojure));
    case 'protobuf':
      return new LanguageSupport(StreamLanguage.define(protobuf));
    case 'scss':
    case 'sass':
      return new LanguageSupport(StreamLanguage.define(sassMode));
    case 'less':
      return new LanguageSupport(StreamLanguage.define(lessMode));
    case 'graphql':
    case 'terraform':
    case 'hcl':
    case 'dart':
    case 'elixir':
    case 'objectivec':
      // No CM6 package and no close legacy mode — fall back to no
      // highlighting rather than misclassifying tokens.
      return [];
    default:
      return [];
  }
}

/// Highlight style tuned to Overcli's palette. We pull the accent + ink
/// colors straight from CSS vars so light/dark mode flips automatically
/// when `html.dark` toggles. The fallback hex values are only there to
/// satisfy CM's color parser before the variable resolves — in practice
/// the var() always wins.
const overcliHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--c-backend-claude, #b587ff)' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--c-backend-claude, #b587ff)' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: 'var(--c-ink, #e8e8ee)' },
  // Property keys + def(variableName) cover both the dedicated parsers
  // (JSON/YAML emit propertyName) and the legacy stream modes
  // (properties/ini emit def, which becomes definition(variableName)).
  { tag: [t.propertyName, t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--c-backend-codex, #5b9cff)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--c-backend-codex, #5b9cff)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--c-backend-gemini, #3dced7)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--c-ink, #e8e8ee)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--c-backend-gemini, #3dced7)' },
  { tag: [t.number, t.changed, t.annotation, t.modifier, t.self], color: '#f59e0b' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link], color: 'var(--c-ink-muted, #a0a0a8)' },
  { tag: [t.meta, t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--c-ink-faint, #666670)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--c-link-file, #5cd6dc)', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--c-accent, #7c8bff)' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#f59e0b' },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: '#a3e635' },
  { tag: [t.attributeName], color: 'var(--c-backend-codex, #5b9cff)' },
  { tag: [t.attributeValue], color: '#a3e635' },
  { tag: t.invalid, color: '#f87171' },
]);

/// Theme that pins font + colors to match the rest of the app. We
/// deliberately render the editor background as transparent so the
/// wrapping pane controls the surface color (light vs. dark vs. focused).
const overcliTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '12px',
      color: 'var(--c-ink)',
      backgroundColor: 'transparent',
    },
    '.cm-scroller': {
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5',
    },
    '.cm-content': {
      caretColor: 'var(--c-ink)',
      padding: '8px 0',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--c-ink-faint)',
      border: 'none',
      paddingRight: '4px',
    },
    '.cm-gutterElement': {
      padding: '0 6px 0 8px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '2.5em',
      textAlign: 'right',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.025)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--c-ink-muted)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--c-ink)',
      borderLeftWidth: '1.5px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(124, 139, 255, 0.28)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(124, 139, 255, 0.18)',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'rgba(124, 139, 255, 0.2)',
      outline: 'none',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(245, 158, 11, 0.25)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(245, 158, 11, 0.45)',
    },
    // CM6's range-highlight class is what we toggle via Decoration.line
    // for the `highlightRange` prop — keep the tint in line with the
    // accent so jumped-to ranges read the same as elsewhere in the app.
    '.cm-overcli-range': {
      backgroundColor: 'rgba(124, 139, 255, 0.12)',
    },
    // Search / replace panel. CM6's default panel is unstyled — plain
    // browser inputs and OS-bevel buttons that stick out against the
    // rest of the app. Restyle to match the `.field` + small-button
    // language used everywhere else (Composer, Settings, etc.).
    '.cm-panels': {
      backgroundColor: 'var(--c-surface-muted)',
      color: 'var(--c-ink)',
      borderColor: 'var(--c-card-border)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--c-card-border)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--c-card-border)',
    },
    '.cm-panel.cm-search': {
      padding: '8px 10px',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      fontSize: '12px',
    },
    '.cm-panel.cm-search label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      color: 'var(--c-ink-muted)',
      fontSize: '11px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-panel.cm-search label input[type="checkbox"]': {
      accentColor: 'var(--c-accent)',
      margin: 0,
    },
    '.cm-panel.cm-search br': {
      // CM inserts <br>s between the search and replace rows; collapse
      // them so the flex layout wraps naturally instead of forcing
      // awkward breaks.
      display: 'none',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--c-card-bg)',
      color: 'var(--c-ink)',
      border: '1px solid var(--c-card-border)',
      borderRadius: '4px',
      padding: '4px 8px',
      fontSize: '12px',
      fontFamily: 'inherit',
      outline: 'none',
      minWidth: '160px',
    },
    '.cm-textfield:focus': {
      borderColor: 'var(--c-accent)',
      boxShadow: '0 0 0 1px var(--c-accent)',
    },
    '.cm-button': {
      backgroundColor: 'var(--c-card-bg)',
      backgroundImage: 'none',
      color: 'var(--c-ink)',
      border: '1px solid var(--c-card-border)',
      borderRadius: '4px',
      padding: '3px 10px',
      fontSize: '11px',
      fontFamily: 'inherit',
      cursor: 'pointer',
    },
    '.cm-button:hover': {
      backgroundColor: 'var(--c-card-bg-strong)',
      borderColor: 'var(--c-card-border-strong)',
    },
    '.cm-button:active': {
      backgroundColor: 'var(--c-card-bg-strong)',
    },
    '.cm-panel.cm-search [name="close"]': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--c-ink-faint)',
      fontSize: '14px',
      cursor: 'pointer',
      padding: '0 4px',
    },
    '.cm-panel.cm-search [name="close"]:hover': {
      color: 'var(--c-ink)',
    },
  },
  { dark: true },
);

/// Build line decorations for the given range against the supplied
/// document. Lifted out so both the field's initial state and its
/// effect-driven updates share the same builder.
function buildRangeDecorations(
  range: HighlightRange,
  doc: { lines: number; line: (n: number) => { from: number } },
): DecorationSet {
  if (!range) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const lo = Math.max(1, range[0]);
  const hi = Math.min(range[1], doc.lines);
  if (hi < lo) return Decoration.none;
  for (let ln = lo; ln <= hi; ln++) {
    const line = doc.line(ln);
    builder.add(line.from, line.from, Decoration.line({ class: 'cm-overcli-range' }));
  }
  return builder.finish();
}

/// StateEffect carries new highlight-range values into the editor;
/// the StateField below holds the live DecorationSet. Modeling the
/// decorations as editor state (instead of computing from a ref a
/// ViewPlugin reads) means:
///   1. The highlight is correct from the very first paint when
///      seeded via `.init()`.
///   2. Edits inside or above the range remap the decoration positions
///      through `tr.changes` — the tint follows the right characters
///      even if the user inserts/deletes lines above.
const setHighlightRange = StateEffect.define<HighlightRange>();

const highlightRangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // Map existing decorations through any doc edits first so the
    // tint follows the characters it was originally attached to.
    let next = deco.map(tr.changes);
    // Then apply any explicit range update from the host — the parent
    // dispatches setHighlightRange when the `highlightRange` prop
    // changes (e.g. user opens a file via a chat path with :42-50).
    for (const e of tr.effects) {
      if (e.is(setHighlightRange)) {
        next = buildRangeDecorations(e.value, tr.state.doc);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function CodeMirrorEditor({
  content,
  onChange,
  highlightRange,
  language,
}: {
  content: string;
  onChange: (v: string) => void;
  highlightRange: HighlightRange;
  language: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  // Wrap onChange in a ref so the updateListener below sees the latest
  // callback without us having to tear down the editor on every parent
  // re-render that hands us a new function identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount once. Subsequent prop changes are handled by the focused
  // effects below; rebuilding the EditorView on every keystroke would
  // discard undo history, scroll position, and the caret.
  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        syntaxHighlighting(overcliHighlight),
        overcliTheme,
        // `Mod-Enter` would otherwise hit defaultKeymap's
        // `insertBlankLine` and clobber the window-level save shortcut
        // wired in FileEditorPane. Binding it to a no-op that returns
        // true short-circuits the keymap chain so insertBlankLine never
        // runs; the keydown still bubbles to the window listener which
        // does the save.
        keymap.of([
          { key: 'Mod-Enter', run: () => true },
          { key: 'Mod-s', run: () => true },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        languageCompartment.current.of(languageExtension(language)),
        // Seed the field with whatever the parent passed on mount so
        // the initial render already has the highlight in place — no
        // visible "flash, then jump" when opening a file with a range.
        highlightRangeField.init((s) => buildRangeDecorations(highlightRange, s.doc)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External content sync — e.g. switching to a different file reloads
  // `content` from disk. Skip the dispatch when the doc already matches
  // to avoid clobbering the user's caret while they're typing (every
  // keystroke also fires this effect because we lifted content into the
  // parent's state).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
  }, [content]);

  // Language swap — reconfigure the compartment in place so the editor
  // keeps its scroll/selection state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  // Highlight range update. Pull out primitive endpoints so the effect
  // deps stay stable (the parent recreates the tuple every render).
  const rangeStart = highlightRange?.[0] ?? null;
  const rangeEnd = highlightRange?.[1] ?? null;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const nextRange: HighlightRange =
      rangeStart != null && rangeEnd != null ? [rangeStart, rangeEnd] : null;
    // One dispatch: update the field (which triggers the decoration
    // recompute via the field's `provide`) and, when there's a range,
    // also scroll it into view. Doing both in one transaction means CM
    // measures once, not twice.
    const effects: StateEffect<unknown>[] = [setHighlightRange.of(nextRange)];
    if (nextRange) {
      const line = view.state.doc.line(
        Math.min(Math.max(1, nextRange[0]), view.state.doc.lines),
      );
      effects.push(EditorView.scrollIntoView(line.from, { y: 'center' }));
    }
    view.dispatch({ effects });
  }, [rangeStart, rangeEnd]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
