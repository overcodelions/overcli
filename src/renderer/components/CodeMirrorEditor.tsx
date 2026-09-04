import { useEffect, useMemo, useRef } from 'react';
import {
  Compartment,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
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
import { changedLinesKey, markPoints, type ChangedLines } from '../changedLines';

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
    // Change gutter — a thin colour bar next to the line numbers marking
    // what this run touched, so the FILE view carries the same information
    // as the diff while you read the code with its context around it.
    '.cm-gutter.cm-overcli-changes': {
      width: '3px',
      padding: 0,
      marginRight: '5px',
    },
    '.cm-overcli-changes .cm-gutterElement': {
      padding: 0,
    },
    '.cm-overcli-change-added': {
      backgroundColor: 'var(--c-diff-add-ink)',
    },
    '.cm-overcli-change-modified': {
      backgroundColor: 'rgba(245, 158, 11, 0.9)',
    },
    // A deletion has no line of its own to colour, so it marks the seam:
    // a stub at the top edge of the line that took the removed lines' place.
    '.cm-overcli-change-deleted': {
      backgroundImage:
        'linear-gradient(to bottom, var(--c-diff-remove-ink) 0 3px, transparent 3px)',
    },
    // Matching wash on the line itself — the same token the diff view's
    // added rows use, so a line reads as "new" the same way in both places.
    '.cm-overcli-line-changed': {
      backgroundColor: 'var(--c-diff-add-bg)',
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
    //
    // The tint alone (it was 0.12 alpha) was easy to miss on a dense
    // screen: you jump to line 412 of a 900-line file and have to hunt for
    // where you landed. So there are three cues now — a stronger wash, a
    // solid accent bar down the left edge of every highlighted line, and a
    // one-shot flash on arrival (see `.cm-overcli-range-flash-*` in
    // styles.css, which also owns the keyframes).
    '.cm-overcli-range': {
      backgroundColor: 'rgba(124, 139, 255, 0.22)',
      boxShadow: 'inset 3px 0 0 var(--c-accent)',
    },
    // The word under the pointer while Cmd/Ctrl is held. Underline plus a
    // pointer cursor is the universal "this is a link" cue, and it's how
    // the go-to-definition gesture announces itself — there's no other
    // signal that Cmd-click does anything at all.
    '.cm-overcli-symbol-link': {
      textDecoration: 'underline',
      textDecorationColor: 'var(--c-accent)',
      textUnderlineOffset: '2px',
      cursor: 'pointer',
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
  flash?: 'a' | 'b',
): DecorationSet {
  if (!range) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const lo = Math.max(1, range[0]);
  const hi = Math.min(range[1], doc.lines);
  if (hi < lo) return Decoration.none;
  const cls = flash ? `cm-overcli-range cm-overcli-range-flash-${flash}` : 'cm-overcli-range';
  for (let ln = lo; ln <= hi; ln++) {
    const line = doc.line(ln);
    builder.add(line.from, line.from, Decoration.line({ class: cls }));
  }
  return builder.finish();
}

/// Git change marks for the open file, or null when there's nothing to
/// show (clean file, non-git folder). Dispatched by the host whenever it
/// re-reads the diff.
const setChangedLines = StateEffect.define<ChangedLines | null>();

/// One bar in the change gutter. `elementClass` rather than `toDOM` so the
/// gutter element itself is the bar — no inner node to size against the
/// line height.
class ChangeBar extends GutterMarker {
  constructor(readonly kind: 'added' | 'modified' | 'deleted') {
    super();
    this.elementClass = `cm-overcli-change-${kind}`;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeBar && other.kind === this.kind;
  }
}

function hasChanges(marks: ChangedLines | null): boolean {
  return !!marks && (marks.changed.length > 0 || marks.deletedAt.length > 0);
}

const CHANGE_BARS = {
  added: new ChangeBar('added'),
  modified: new ChangeBar('modified'),
  deleted: new ChangeBar('deleted'),
};

/// Walk changed lines and deletion seams together in line order — both
/// RangeSetBuilders below require ascending positions, and the two lists
/// interleave.
function eachMark(
  marks: ChangedLines | null,
  doc: { lines: number; line: (n: number) => { from: number } },
  visit: (from: number, kind: 'added' | 'modified' | 'deleted') => void,
) {
  if (!marks) return;
  let ci = 0;
  let di = 0;
  while (ci < marks.changed.length || di < marks.deletedAt.length) {
    const c = marks.changed[ci];
    const d = marks.deletedAt[di];
    const takeChanged = c != null && (d == null || c.line <= d);
    const line = takeChanged ? c.line : d;
    if (takeChanged) ci++;
    else di++;
    // The diff is fetched asynchronously and the buffer can be edited in
    // the meantime, so a stale mark past the end of the document is
    // ordinary, not a bug — drop it.
    if (line < 1 || line > doc.lines) continue;
    visit(doc.line(line).from, takeChanged ? c.kind : 'deleted');
  }
}

function buildChangeGutter(
  marks: ChangedLines | null,
  doc: { lines: number; line: (n: number) => { from: number } },
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  eachMark(marks, doc, (from, kind) => builder.add(from, from, CHANGE_BARS[kind]));
  return builder.finish();
}

function buildChangeDecorations(
  marks: ChangedLines | null,
  doc: { lines: number; line: (n: number) => { from: number } },
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  eachMark(marks, doc, (from, kind) => {
    // Only lines that exist in the new file get a wash; a deletion seam is
    // a boundary, and tinting the surviving line would misreport it.
    if (kind === 'deleted') return;
    builder.add(from, from, Decoration.line({ class: 'cm-overcli-line-changed' }));
  });
  return builder.finish();
}

/// Both change views are editor state for the same reason the highlight
/// range is: typing above a marked line has to carry its bar and wash
/// along with it, which `map(tr.changes)` does for free.
const changeGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setChangedLines)) next = buildChangeGutter(e.value, tr.state.doc);
    }
    return next;
  },
});

const changeLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setChangedLines)) next = buildChangeDecorations(e.value, tr.state.doc);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/// The gutter extension itself. Held apart from the fields so it can be
/// swapped in and out of a compartment — a file with no changes shouldn't
/// pay a blank column's worth of indent for a gutter with nothing in it.
const changeGutter = gutter({
  class: 'cm-overcli-changes',
  markers: (v) => v.state.field(changeGutterField),
});

/// Put `line` on screen, centred. `moveCaret` for the deliberate jumps
/// (ruler click, keyboard) so the next jump continues from where you
/// landed; off for the automatic reveal on open, which should scroll the
/// view without touching a caret the user never placed.
function revealLine(view: EditorView, line: number, moveCaret: boolean) {
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({
    ...(moveCaret ? { selection: { anchor: target.from } } : {}),
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    scrollIntoView: false,
  });
}

/// Jump to the next/previous changed line, wrapping at the ends — the
/// file view's answer to "where else did this run touch?" without having
/// to eyeball the ruler.
function jumpToChange(
  view: EditorView,
  marks: ChangedLines | null,
  dir: 1 | -1,
): boolean {
  const points = markPoints(marks, view.state.doc.lines);
  if (!points.length) return false;
  const here = view.state.doc.lineAt(view.state.selection.main.head).number;
  const found =
    dir === 1
      ? points.find((p) => p.line > here)
      : [...points].reverse().find((p) => p.line < here);
  revealLine(view, (found ?? (dir === 1 ? points[0] : points[points.length - 1])).line, true);
  return true;
}

const RULER_TICK_COLOR: Record<'added' | 'modified' | 'deleted', string> = {
  added: 'var(--c-diff-add-ink)',
  modified: 'rgba(245, 158, 11, 0.9)',
  deleted: 'var(--c-diff-remove-ink)',
};

/// Overview ruler: the whole file squashed into a 10px column, with a tick
/// wherever the run touched it. Opening a file used to tell you nothing
/// about where its changes were — the gutter bars only exist for the lines
/// already on screen, so a change 900 lines down was invisible until you
/// found it. Clicking snaps to the nearest change rather than to the exact
/// pixel: at one document per ten pixels, the tick is what you were aiming
/// at, not the line beside it.
function ChangeRuler({
  marks,
  lineCount,
  viewRef,
}: {
  marks: ChangedLines | null;
  lineCount: number;
  viewRef: React.RefObject<EditorView | null>;
}) {
  const points = useMemo(() => markPoints(marks, lineCount), [marks, lineCount]);
  if (!points.length) return null;
  const jump = (e: React.MouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.height <= 0) return;
    const wanted = ((e.clientY - box.top) / box.height) * lineCount;
    let nearest = points[0];
    for (const p of points) {
      if (Math.abs(p.line - wanted) < Math.abs(nearest.line - wanted)) nearest = p;
    }
    revealLine(view, nearest.line, true);
  };
  return (
    <div
      className="relative w-[10px] shrink-0 cursor-pointer py-2"
      onMouseDown={jump}
      title={`${points.length} changed ${points.length === 1 ? 'line' : 'lines'} — click to jump (⌘⌥↑/↓)`}
    >
      <div className="relative h-full w-full">
        {points.map((p) => (
          <div
            key={p.line}
            className="absolute left-[2px] right-[2px] h-[2px] rounded-[1px]"
            style={{
              top: `${((p.line - 0.5) / lineCount) * 100}%`,
              backgroundColor: RULER_TICK_COLOR[p.kind],
            }}
          />
        ))}
      </div>
    </div>
  );
}

/// Hovered-symbol underline. Carries the word range under the pointer
/// while the go-to-definition modifier is held, or null.
const setHoverSymbol = StateEffect.define<{ from: number; to: number } | null>();

/// Identifier shape the lookup will actually accept. Mirrors SYMBOL_RE in
/// main/symbolLookup.ts, which is the authority — main re-checks and
/// rejects anything else. Kept here (a copy of one regex, rather than a
/// shared module) so the renderer never imports main-process code; the
/// worst a drift can do is underline a word that then can't be resolved.
/// `wordAt` happily returns numeric literals and the like, and underlining
/// `2500` promises a jump that would come back as an error overlay.
const LOOKUP_SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

/// Cmd/Ctrl-hover underline for the go-to-definition gesture.
///
/// Nothing in the UI said the gesture existed — you had to already know.
/// Rather than spend chrome on a hint, this teaches it the way every IDE
/// does: hold the modifier and whatever your pointer is over turns into a
/// link. It also doubles as a target check, since it shows exactly which
/// word a click would resolve.
const hoverSymbolField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHoverSymbol)) continue;
      next = e.value
        ? Decoration.set([
            Decoration.mark({ class: 'cm-overcli-symbol-link' }).range(e.value.from, e.value.to),
          ])
        : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/// Alternates the flash class on every applied range. A CSS animation only
/// restarts when the class list actually changes, so jumping to the *same*
/// line twice (click the same `file:42` link again) would otherwise flash
/// once and then sit silent on every later click.
let flashParity = 0;

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
        flashParity ^= 1;
        next = buildRangeDecorations(e.value, tr.state.doc, flashParity ? 'a' : 'b');
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
  changedLines = null,
  revealKey = null,
  onSymbolNavigate,
  onSelectionChange,
}: {
  content: string;
  onChange: (v: string) => void;
  highlightRange: HighlightRange;
  language: string | null;
  /// Lines this file's git diff touched, in new-file numbering. Drives the
  /// change gutter; null (the default) leaves the gutter empty, which is
  /// what a clean file or a non-git folder wants.
  changedLines?: ChangedLines | null;
  /// Identity of the document on screen (the host passes the file path).
  /// When it changes, the first change in the new file is scrolled into
  /// view once — a re-fetched diff for the same file never re-scrolls, so
  /// saving can't yank you away from what you were reading.
  revealKey?: string | null;
  /// Cmd-click (Ctrl-click off macOS) on an identifier. The host resolves
  /// it to a definition site and opens it; this component only reports
  /// which word was clicked and on what line.
  onSymbolNavigate?: (args: { symbol: string; line: number }) => void;
  /// Fires whenever the selection moves. Lets a host scope an operation to
  /// what the user highlighted instead of the whole document.
  onSelectionChange?: (
    sel: { from: number; to: number; text: string; lineCount: number } | null,
  ) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const changeGutterCompartment = useRef(new Compartment());
  // Wrap onChange in a ref so the updateListener below sees the latest
  // callback without us having to tear down the editor on every parent
  // re-render that hands us a new function identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Same ref trick, same reason: the listener is baked into the mount-once
  // extension list and must read the latest callback through a ref.
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // Same ref trick for the navigate callback — the DOM handler is baked
  // into the mount-once extension list, so it has to read through a ref to
  // see the current closure.
  const onSymbolNavigateRef = useRef(onSymbolNavigate);
  onSymbolNavigateRef.current = onSymbolNavigate;
  // Read through a ref by the mount-once extension list; the effect below
  // owns every update after that.
  const changedLinesRef = useRef(changedLines);
  changedLinesRef.current = changedLines;
  // The reveal is armed by opening a file and disarmed by the first thing
  // that makes the scroll position the user's rather than ours: the reveal
  // itself, or an edit (which means they found the code without us).
  const pendingRevealRef = useRef(false);
  const revealedKeyRef = useRef<string | null>(null);

  // Mount once. Subsequent prop changes are handled by the focused
  // effects below; rebuilding the EditorView on every keystroke would
  // discard undo history, scroll position, and the caret.
  useEffect(() => {
    if (!containerRef.current) return;

    // ---- Cmd/Ctrl-hover link affordance -------------------------------
    // State for the handlers below, scoped to this view. `hovered` is
    // tracked so we only dispatch when the underlined word actually
    // changes — a mousemove fires per pixel, and a transaction per pixel
    // would be absurd.
    let hovered: { from: number; to: number } | null = null;
    let lastPointer: { x: number; y: number } | null = null;

    const setHover = (view: EditorView, next: { from: number; to: number } | null) => {
      if (hovered?.from === next?.from && hovered?.to === next?.to) return;
      hovered = next;
      view.dispatch({ effects: setHoverSymbol.of(next) });
    };
    const clearHover = (view: EditorView) => setHover(view, null);
    const applyHover = (view: EditorView, modifierHeld: boolean) => {
      // Only offer the link where the gesture actually does something:
      // no navigate callback (the compare view, say) means no underline.
      if (!modifierHeld || !onSymbolNavigateRef.current || !lastPointer) {
        clearHover(view);
        return;
      }
      const pos = view.posAtCoords(lastPointer);
      const word = pos == null ? null : view.state.wordAt(pos);
      const resolvable =
        !!word && LOOKUP_SYMBOL_RE.test(view.state.sliceDoc(word.from, word.to));
      setHover(view, resolvable && word ? { from: word.from, to: word.to } : null);
    };
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        // Seeded on mount like the highlight range, so a file opened
        // straight into the editor shows its bars on the first paint
        // rather than after a re-render.
        changeGutterField.init((st) => buildChangeGutter(changedLinesRef.current, st.doc)),
        changeLinesField.init((st) => buildChangeDecorations(changedLinesRef.current, st.doc)),
        changeGutterCompartment.current.of(hasChanges(changedLinesRef.current) ? changeGutter : []),
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
          // Next/previous change. Cmd-Alt rather than the bare Alt-Arrow
          // an IDE would use, because defaultKeymap already spends
          // Alt-Arrow and Shift-Alt-Arrow on move/copy line.
          {
            key: 'Mod-Alt-ArrowDown',
            run: (v) => jumpToChange(v, changedLinesRef.current, 1),
          },
          {
            key: 'Mod-Alt-ArrowUp',
            run: (v) => jumpToChange(v, changedLinesRef.current, -1),
          },
          { key: 'Mod-s', run: () => true },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        languageCompartment.current.of(languageExtension(language)),
        // Go-to-definition gesture. We handle mousedown rather than click
        // so CM's own selection handling never runs — a Cmd-click that
        // moved the caret and *then* jumped would leave the user's cursor
        // somewhere surprising if the lookup failed.
        hoverSymbolField,
        EditorView.domEventHandlers({
          mousedown(event, view) {
            const navigate = onSymbolNavigateRef.current;
            if (!navigate) return false;
            // Cmd on macOS, Ctrl elsewhere — the IDE gesture either way.
            const withModifier = event.metaKey || event.ctrlKey;
            if (!withModifier || event.button !== 0) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const word = view.state.wordAt(pos);
            if (!word) return false;
            const symbol = view.state.sliceDoc(word.from, word.to);
            // Same guard as the hover underline: don't spend a lookup (and
            // an error overlay) on a numeric literal or punctuation.
            if (!symbol || !LOOKUP_SYMBOL_RE.test(symbol)) return false;
            event.preventDefault();
            clearHover(view);
            navigate({ symbol, line: view.state.doc.lineAt(word.from).number });
            return true;
          },
          mousemove(event, view) {
            // Remembered even without the modifier, so pressing Cmd while
            // the pointer sits still can underline the word it's already on.
            lastPointer = { x: event.clientX, y: event.clientY };
            applyHover(view, event.metaKey || event.ctrlKey);
            return false;
          },
          mouseleave(_event, view) {
            lastPointer = null;
            clearHover(view);
            return false;
          },
        }),
        // Seed the field with whatever the parent passed on mount so
        // the initial render already has the highlight in place — no
        // visible "flash, then jump" when opening a file with a range.
        // Flashes on mount too: opening a file straight onto a range is
        // exactly when you most need to be told where you landed.
        highlightRangeField.init((s) =>
          buildRangeDecorations(highlightRange, s.doc, (flashParity ^= 1) ? 'a' : 'b'),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            pendingRevealRef.current = false;
            onChangeRef.current(u.state.doc.toString());
          }
          if (!u.selectionSet && !u.docChanged) return;
          const report = onSelectionChangeRef.current;
          if (!report) return;
          const range = u.state.selection.main;
          if (range.empty) {
            report(null);
            return;
          }
          const text = u.state.doc.sliceString(range.from, range.to);
          report({
            from: range.from,
            to: range.to,
            text,
            lineCount: u.state.doc.lineAt(range.to).number - u.state.doc.lineAt(range.from).number + 1,
          });
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    // On the window, not the editor: the modifier is usually pressed with
    // the pointer already resting over a word and the editor unfocused, so
    // editor-scoped key handlers would never see it. Releasing has to
    // clear the underline too, or a link is left hanging under the cursor.
    const onModifierKey = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' && e.key !== 'Control') return;
      applyHover(view, e.type === 'keydown');
    };
    // A modifier release that happens while the window is in the
    // background (Cmd-Tab away) never reaches us, so clear on blur.
    const onWindowBlur = () => clearHover(view);
    window.addEventListener('keydown', onModifierKey);
    window.addEventListener('keyup', onModifierKey);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      window.removeEventListener('keydown', onModifierKey);
      window.removeEventListener('keyup', onModifierKey);
      window.removeEventListener('blur', onWindowBlur);
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

  // Change-mark update. Keyed on the marks' content rather than the object
  // identity: the host rebuilds the array whenever it re-reads the diff,
  // and re-dispatching identical marks would throw away the mapping that
  // has been tracking the user's edits.
  const marksKey = changedLinesKey(changedLines);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const marks = changedLinesRef.current;
    view.dispatch({
      effects: [
        setChangedLines.of(marks),
        changeGutterCompartment.current.reconfigure(hasChanges(marks) ? changeGutter : []),
      ],
    });
    // The diff lands a beat after the file does, so the reveal has to
    // happen here rather than on open: this is the first moment we know
    // where the changes are. An explicit range (a chat link to :42) is the
    // user's own destination and wins.
    if (!pendingRevealRef.current || rangeStart != null) return;
    const first = markPoints(marks, view.state.doc.lines)[0];
    if (!first) return;
    pendingRevealRef.current = false;
    revealLine(view, first.line, false);
  }, [marksKey, rangeStart]);

  // Arm the reveal for each newly opened document. Held apart from the
  // effect above so re-fetching the same file's diff — which is what a
  // save does — leaves the scroll position alone.
  useEffect(() => {
    if (!revealKey || revealedKeyRef.current === revealKey) return;
    revealedKeyRef.current = revealKey;
    pendingRevealRef.current = true;
  }, [revealKey]);

  const lineCount = useMemo(() => content.split('\n').length, [content]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full min-w-0 flex-1 overflow-hidden" />
      <ChangeRuler marks={changedLines} lineCount={lineCount} viewRef={viewRef} />
    </div>
  );
}
