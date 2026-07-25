# widgets/

One `.tsx` file per widget, default-exporting a `WidgetDef` (see `../widget.ts`).
Discovery is vite's `import.meta.glob` in `widget.ts` — adding a widget is dropping a
file, nothing else to edit (no barrel file, no codegen).

Widgets render parameter editors for the composer (llm picker, enum select, struct-table
with the column dice, …). The viewer pages don't use them. Empty until the composer lands
(v0.md §5 has the full architecture: seven widgets + vary/randomize/raw wrappers).
