import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useMantineTheme, type MantineTheme } from "@mantine/core";
import { resolveBrushColor } from "@renderer/lib/colors";
import { findBrushTokens } from "@renderer/lib/generate/pattern-tokens";
import { resolveBrushToken } from "@renderer/lib/generate/resolve-brush";
import { useStore } from "@renderer/store";
import type { Brush } from "@renderer/store/types";
import { useEffect, useRef } from "react";

/** How a brush reference in the pattern is underlined. */
interface TokenStyle {
  color: string;
  /** False when the token names no brush and falls back to the active one. */
  exact: boolean;
}

function styleForToken(token: string, brushes: Brush[], activeIndex: number, theme: MantineTheme): TokenStyle | null {
  const resolved = resolveBrushToken(token, brushes);
  const brush = brushes[resolved ?? activeIndex];
  if (!brush) return null;
  return { color: resolveBrushColor(brush.color, theme), exact: resolved !== null };
}

function buildDecorations(code: string, brushes: Brush[], activeIndex: number, theme: MantineTheme): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const { from, to, token } of findBrushTokens(code)) {
    const style = styleForToken(token, brushes, activeIndex, theme);
    if (!style) continue;
    marks.push(
      Decoration.mark({
        attributes: {
          style: `text-decoration: underline ${style.exact ? "solid" : "dashed"}; text-decoration-color: ${
            style.color
          }; text-decoration-thickness: 2px; text-underline-offset: 3px;`,
        },
      }).range(from, to),
    );
  }
  return Decoration.set(marks, true);
}

/** Palette the decorations paint with; kept outside the plugin so it can be swapped in place. */
interface BrushPalette {
  brushes: Brush[];
  activeIndex: number;
  theme: MantineTheme;
}

function brushUnderlines(palette: { current: BrushPalette }): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        this.decorations = this.build(update.view);
      }

      build(view: EditorView): DecorationSet {
        const { brushes, activeIndex, theme } = palette.current;
        return buildDecorations(view.state.doc.toString(), brushes, activeIndex, theme);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--mantine-color-dark-7)",
      border: "1px solid var(--mantine-color-dark-4)",
      borderRadius: "var(--mantine-radius-sm)",
      fontSize: "12px",
      color: "var(--mantine-color-gray-3)",
    },
    "&.cm-focused": { outline: "none", borderColor: "var(--mantine-color-dark-3)" },
    ".cm-content": {
      padding: "5px 8px",
      fontFamily: "var(--mantine-font-family-monospace)",
      caretColor: "var(--mantine-color-gray-3)",
    },
    ".cm-line": { padding: 0 },
    ".cm-cursor": { borderLeftColor: "var(--mantine-color-gray-3)" },
    "&.cm-editor .cm-selectionBackground, & .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--mantine-color-dark-4)",
    },
    ".cm-scroller": { overflowX: "auto" },
  },
  { dark: true },
);

/**
 * Single-field editor for the Generate pattern. Brush references inside quoted
 * strings are underlined in the colour of the brush they select — dashed when
 * the token names no brush and the active one is used instead.
 */
export function PatternEditor({ onRun }: { onRun: () => void }) {
  const theme = useMantineTheme();
  const code = useStore((state) => state.generateCode);
  const setGenerateCode = useStore((state) => state.setGenerateCode);
  const brushes = useStore((state) => state.brushes);
  const activeBrushIndex = useStore((state) => state.activeBrushIndex);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef(onRun);
  const paletteRef = useRef<BrushPalette>({ brushes, activeIndex: activeBrushIndex, theme });

  runRef.current = onRun;

  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: useStore.getState().generateCode,
        extensions: [
          history(),
          keymap.of([{ key: "Mod-Enter", run: () => (runRef.current(), true) }, ...defaultKeymap, ...historyKeymap]),
          EditorState.transactionFilter.of((transaction) => (transaction.newDoc.lines > 1 ? [] : transaction)),
          brushUnderlines(paletteRef),
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setGenerateCode(update.state.doc.toString());
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [setGenerateCode]);

  // Repaint the underlines whenever the palette they refer to changes.
  useEffect(() => {
    paletteRef.current = { brushes, activeIndex: activeBrushIndex, theme };
    viewRef.current?.dispatch({});
  }, [brushes, activeBrushIndex, theme]);

  // Adopt code set from outside the editor, such as picking a preset.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === code) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: code } });
  }, [code]);

  return <div ref={hostRef} style={{ flex: 1, minWidth: 0 }} />;
}
