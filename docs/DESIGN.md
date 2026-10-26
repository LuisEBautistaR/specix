# Design System: Specix

Specix uses the **Sendix design system unchanged** ("The Stone Workbench", [DESIGN-base.md](DESIGN-base.md)), like Mockix:

- three stones per theme, and grey-green #5c6b54 only on the primary action, the selection tint and the focus ring;
- Archivo 11–15px, with the wordmark as the ceiling, and JetBrains Mono with ligatures off;
- earth inks for methods and statuses, always next to their word;
- the strata idea as signature (here, the lifecycle bar).

All three apps belong to the protohub.digital family. This file lists only what Specix adds.

## Shell

Same grid as Sendix (38px title bar, 44px rail, 264px sidebar, main area, 24px status bar, reference frame 1440×900). Differences:

- **Title bar**: the environment picker becomes the **API pill** (API name, mono version, state word "borrador" or "publicada"), followed by the **git pill** (branch icon, branch, number of changes).
- **Rail**: Diseño, Versiones, Gobernanza, Ciclo ix, Documentación; Agentes (MCP) and Ajustes at the bottom. Código / Formulario / Comentarios are sub-tabs of Diseño, not rail items.
- **Status bar**: Mockix sync state, problem counts with their words, workspace path, IA and MCP state, and the "Datos de ejemplo" tag.

## Additions

- **Warning ink**: `--warn` reuses the POST amber (`--m-post`). Severity always shows its word: Error (Fail Brick), Aviso (amber), Info (muted), Pista (faint).
- **Editor diagnostics**: a 2px inset bar in the gutter edge (brick for errors, amber for warnings, strong seam for info) and a wavy underline under the exact token. Only error lines get a tint (`--err-bg`). The current line uses `--hover`.
- **Completion list**: a floating layer with the shared shadow, 340px, 24px rows: kind glyph, name in mono with the typed prefix in bold, type on the right; a Field-coloured doc footer with origin file and usage count.
- **Problems panel**: 206px under the editor; 28px rows with severity word, message, rule id in faint mono (ellipsis) and location. Filter seg: Todos / Estructura / Guía.
- **Breadcrumb**: 12px mono path of the node under the caret, cursor position on the right.
- **Lifecycle bar** (Specix's strata): four equal segments, Diseño → Validado → Simulado → Probado, coloured strata-2…5 when done, hatched when not reached, filled up to a percentage when partial. Each caption has the stage word plus a short mono fact ("1 error", ":3000", "12 de 14"). Stones mean sequence only; the failure word carries the colour.
- **Docs preview**: operation lists on Field wells, expanded operation tinted with Selection Moss, schema trees with a left seam and dashed row dividers; types in the GET teal; "oblig." as an outlined 10.5px tag. A stale note says when the preview shows the last valid version.
- **Form editor**: 28px Field inputs, 112px label column; the focused input gets the Focus Moss ring; inline hints at the right say which rule the edit fixes.
- **Version diff**: two code wells side by side; added lines tinted Selection Moss with "+", removed lines muted with "−", padding rows hatched. Change kinds are outlined tags: incompatible (Fail Brick, it earns the colour), aviso (amber), compatible (neutral).
- **Comment threads**: Field cards anchored by JSON Pointer (mono header) with the quoted line; the selected thread has a Focus Moss border; resolved threads lead with "Resuelto" in Pass Green. Lines with comments show a small speech icon and count after the code.
- **Drift list**: rows with kind word, finding (method ink + mono fields), request count, and a faint evidence line.
- **AI dialog**: the only other shadowed surface. 480px at the bottom right of the main area. It states what was sent, to whom and what was not sent, lists the fixes as checkboxes and shows the diff before anything is applied.

## Rules carried over

No text above 15px or below 10.5px. No large empty regions: tall panes are filled with context (outline, git history, impact on Mockix and Sendix, functions in use). Every colour goes with a word. Both themes keep WCAG AA.
