/**
 * The definition editor: CodeMirror 6 with YAML/JSON, diagnostics from the
 * language host, schema-driven completion, hover help and go to definition.
 *
 * It lives in a shadow root because only there does CodeMirror use
 * adoptedStyleSheets; in the document it would add an inline <style>, which
 * the strict CSP blocks. Colours come from the design tokens, which custom
 * properties carry into the shadow root.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorSelection, EditorState, type Text } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import type { Cursor } from "../../preload/api";
import type { Diagnostic, Position, TextRange } from "@shared/ipc";
import type { Prefs } from "@shared/prefs";

const highlight = HighlightStyle.define([
  { tag: [t.keyword], color: "var(--syn-kw)" },
  { tag: [t.string, t.special(t.string), t.content], color: "var(--syn-str)" },
  { tag: [t.number], color: "var(--syn-num)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-lit)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--syn-key)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-com)", fontStyle: "italic" },
  { tag: [t.punctuation, t.bracket, t.separator, t.meta], color: "var(--syn-punct)" },
  { tag: [t.labelName, t.typeName], color: "var(--syn-kw)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--field)", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "19px", fontVariantLigatures: "none", fontFeatureSettings: '"calt" 0, "liga" 0' },
  ".cm-content": { padding: "6px 0", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--field)", border: "none", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "36px", padding: "0 8px 0 4px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "var(--faint)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--select) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--select)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--hover)" },
  // Diagnostics: a wavy underline in the severity ink, never a coloured background.
  ".cm-lintRange": { backgroundImage: "none", paddingBottom: "0" },
  ".cm-lintRange-error": { textDecoration: "underline wavy var(--err)", textDecorationThickness: "1px", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { textDecoration: "underline wavy var(--m-post)", textDecorationThickness: "1px", textUnderlineOffset: "3px" },
  ".cm-lintRange-info, .cm-lintRange-hint": { textDecoration: "underline dotted var(--muted)", textUnderlineOffset: "3px" },
  ".cm-lint-marker": { width: "8px", height: "8px", borderRadius: "50%", content: "none" },
  ".cm-lint-marker-error": { backgroundColor: "var(--err)" },
  ".cm-lint-marker-warning": { backgroundColor: "var(--m-post)" },
  ".cm-lint-marker-info": { backgroundColor: "var(--line-strong)" },
  ".cm-gutter-lint": { width: "12px" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "5px 0 0 2px" },
  // Floating layers: the shared shadow, stone colours.
  ".cm-tooltip": {
    backgroundColor: "var(--work)",
    color: "var(--ink)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    boxShadow: "var(--shadow)",
    fontFamily: "var(--ui)",
    fontSize: "12.5px",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px", lineHeight: "20px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--select)", color: "var(--select-ink)" },
  ".cm-completionLabel": { fontWeight: "500" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700" },
  ".cm-completionDetail": { fontFamily: "var(--ui)", fontStyle: "normal", color: "var(--muted)", marginLeft: "12px", fontSize: "11.5px" },
  ".cm-tooltip.cm-completionInfo": { maxWidth: "300px", padding: "6px 9px", backgroundColor: "var(--field)", lineHeight: "1.45" },
  ".cm-tooltip-hover": { maxWidth: "360px" },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": { padding: "5px 9px", borderLeft: "2px solid var(--line-strong)" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--err)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--m-post)" },
  ".sx-hover": { padding: "6px 9px", lineHeight: "1.45" },
  ".sx-hover b": { fontFamily: "var(--mono)", fontWeight: "600", fontSize: "12px" },
  ".sx-hover .ty": { color: "var(--muted)", marginLeft: "8px", fontSize: "11.5px" },
  ".sx-hover p": { margin: "3px 0 0", color: "var(--ink)" },
  ".cm-panels": { backgroundColor: "var(--rail)", color: "var(--ink)", borderTop: "1px solid var(--line)" },
});

const SEVERITY: Record<Diagnostic["severity"], CmDiagnostic["severity"]> = { error: "error", warning: "warning", info: "info", hint: "hint" };

const toPos = (doc: Text, p: Position): number => {
  const line = doc.line(Math.min(Math.max(1, p.line), doc.lines));
  return Math.min(line.from + Math.max(0, p.column - 1), line.to);
};
const toPosition = (doc: Text, pos: number): Position => {
  const line = doc.lineAt(pos);
  return { line: line.number, column: pos - line.from + 1 };
};

export interface EditorServices {
  complete(cursor: Cursor): Promise<import("@shared/ipc").CompletionResult | null>;
  hover(cursor: Cursor): Promise<import("@shared/ipc").HoverResult | null>;
  definition(cursor: Cursor): Promise<TextRange | null>;
}

export interface SpecEditorHandle {
  /** Selects a range, scrolls to it and focuses the editor. */
  reveal(range: TextRange): void;
}

interface Props {
  value: string;
  onChange(value: string): void;
  format: "yaml" | "json";
  diagnostics: Diagnostic[];
  services: EditorServices;
  onCursor?(position: Position): void;
  /** Ctrl+S inside the editor. */
  onSave?(): void;
  readOnly?: boolean;
  /** Font size, indentation, auto-closing and wrapping, from Ajustes. */
  settings: Prefs["editor"];
  label: string;
  testId?: string;
}

/** Everything Ajustes can change in a live editor. */
const configured = (s: Prefs["editor"]) => [
  EditorState.tabSize.of(s.tabSize),
  indentUnit.of(" ".repeat(s.tabSize)),
  s.closeBrackets ? closeBrackets() : [],
  s.lineWrap ? EditorView.lineWrapping : [],
  EditorView.theme({ "&": { fontSize: `${s.fontSize}px` }, ".cm-scroller": { lineHeight: `${s.fontSize + 7}px` } }),
];

export const SpecEditor = forwardRef<SpecEditorHandle, Props>(function SpecEditor({ value, onChange, format, diagnostics, services, onCursor, onSave, readOnly = false, settings, label, testId }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const tuning = useRef(new Compartment());
  // Callbacks change on every render; the editor keeps reading the latest ones.
  const latest = useRef({ onChange, services, onCursor, onSave });
  latest.current = { onChange, services, onCursor, onSave };

  const goToDefinition = (v: EditorView, pos: number): boolean => {
    const cursor = { text: v.state.doc.toString(), ...toPosition(v.state.doc, pos) };
    void latest.current.services.definition(cursor).then((range) => {
      if (!range || view.current !== v) return;
      const anchor = toPos(v.state.doc, range.start);
      v.dispatch({ selection: EditorSelection.range(anchor, toPos(v.state.doc, range.end)), effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
      v.focus();
    });
    return true;
  };

  useImperativeHandle(ref, () => ({
    reveal(range) {
      const v = view.current;
      if (!v) return;
      const from = toPos(v.state.doc, range.start);
      const to = Math.max(from, toPos(v.state.doc, range.end));
      v.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) });
      v.focus();
    },
  }));

  useEffect(() => {
    const completionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
      const cursor = { text: ctx.state.doc.toString(), ...toPosition(ctx.state.doc, ctx.pos) };
      const result = await latest.current.services.complete(cursor);
      if (!result || ctx.aborted || result.items.length === 0) return null;
      return {
        from: toPos(ctx.state.doc, result.from),
        to: Math.max(ctx.pos, toPos(ctx.state.doc, result.to)),
        validFor: /^['"]?[\w$#/.\-~{}]*$/,
        options: result.items.map((item, i) => ({
          label: item.label,
          apply: item.insert,
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.info ? { info: item.info } : {}),
          type: item.kind === "reference" ? "variable" : item.kind === "value" ? "constant" : "property",
          boost: -i / 1000,
        })),
      };
    };

    const hoverHelp = hoverTooltip(async (v, pos) => {
      const cursor = { text: v.state.doc.toString(), ...toPosition(v.state.doc, pos) };
      const help = await latest.current.services.hover(cursor);
      if (!help) return null;
      return {
        pos: toPos(v.state.doc, help.range.start),
        end: toPos(v.state.doc, help.range.end),
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "sx-hover";
          const title = document.createElement("b");
          title.textContent = help.title;
          dom.append(title);
          if (help.type) {
            const type = document.createElement("span");
            type.className = "ty";
            type.textContent = help.type;
            dom.append(type);
          }
          if (help.text) {
            const text = document.createElement("p");
            text.textContent = help.text;
            dom.append(text);
          }
          return { dom };
        },
      };
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        lintGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        tuning.current.of(configured(settings)),
        language.current.of(format === "json" ? json() : yaml()),
        editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        syntaxHighlighting(highlight),
        autocompletion({ override: [completionSource], icons: false, activateOnTyping: true, maxRenderedOptions: 200 }),
        hoverHelp,
        keymap.of([
          { key: "F12", run: (v) => goToDefinition(v, v.state.selection.main.head) },
          { key: "Mod-s", preventDefault: true, run: () => (latest.current.onSave?.(), true) },
          { key: "Mod-Space", run: startCompletion },
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap.filter((k) => k.key !== "Mod-Enter"),
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.domEventHandlers({
          mousedown(event, v) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            event.preventDefault();
            return goToDefinition(v, pos);
          },
        }),
        EditorView.contentAttributes.of({ "aria-label": label, ...(testId ? { "data-testid": testId } : {}) }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const main = u.state.selection.main;
            // Tests (and future features) read the selection from the host element.
            host.current?.setAttribute("data-selected-text", u.state.sliceDoc(main.from, main.to));
            latest.current.onCursor?.(toPosition(u.state.doc, main.head));
          }
        }),
        theme,
      ],
    });
    const el = host.current!;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    view.current = new EditorView({ state, root: shadow, parent: shadow });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // The editor is created once; outside changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(format === "json" ? json() : yaml()) });
  }, [format]);

  useEffect(() => {
    view.current?.dispatch({ effects: tuning.current.reconfigure(configured(settings)) });
  }, [settings]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const marks: CmDiagnostic[] = diagnostics.map((d) => {
      const from = toPos(doc, d.range.start);
      return { from, to: Math.max(from, toPos(doc, d.range.end)), severity: SEVERITY[d.severity], message: d.message, source: d.source };
    });
    v.dispatch(setDiagnostics(v.state, marks));
  }, [diagnostics]);

  return <div className={readOnly ? "cm-host ro" : "cm-host"} ref={host} data-readonly={readOnly} />;
});
