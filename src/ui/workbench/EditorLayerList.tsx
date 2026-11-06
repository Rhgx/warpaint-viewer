import { Link2, Lock, RefreshCw } from 'lucide-react';
import { STICKER_THUMB } from '../editor/editorStyles';
import { cn } from '../primitives/cn';
import type { WorkbenchEditor } from './workbenchTypes';

// The selected mark sits on the leading edge of a column, and on the bottom edge of the single row it becomes when narrow.
const ROW = 'flex min-h-control cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-1.25 text-left text-text transition-fast outline-accent hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 aria-selected:bg-accent-soft aria-selected:shadow-[inset_2px_0_0_var(--color-accent)] @max-[900px]:max-w-55 @max-[900px]:min-h-8 @max-[900px]:flex-none @max-[900px]:rounded-sm @max-[900px]:py-0.75 @max-[900px]:pr-2.5 @max-[900px]:pl-1 @max-[900px]:aria-selected:shadow-[inset_0_-2px_0_var(--color-accent)]';
const LABEL = 'min-w-0 flex-1 truncate text-11.5 font-semibold';
const LAYER_THUMB = 'relative block size-8 flex-none overflow-hidden rounded-sm border border-strong/60 bg-panel-2 @max-[900px]:size-6';
const LAYER_IMAGE = 'size-full object-cover';
const LAYER_SWATCH = 'absolute right-0.5 bottom-0.5 size-1.75 rounded-xs border border-white/55 bg-current shadow-[0_0_0_1px_rgb(0_0_0/40%)]';
const COUNT = 'min-w-[2ch] flex-none text-right text-10 text-dim tabular-nums';
// Marks a layer with a non-default transform range, so it is findable without opening each one.
const VARY_MARK = 'inline-grid size-4 flex-none place-items-center text-accent';
const LOCK_MARK = 'inline-grid size-4 flex-none place-items-center text-dim';
const NOTE = 'm-2.5 text-10.5 text-dim';

export function EditorLayerList({
  editor,
  materialsActive,
}: {
  editor: WorkbenchEditor;
  materialsActive: boolean;
}) {
  // The base layer is listed after the selectors, so its swatch sits at that index.
  const baseLayerSwatch =
    editor.layerSwatchColors?.[editor.selectors.length] ?? editor.layerColors?.[editor.selectors.length];
  return (
    <div
      // Materials has nothing to list, and when narrow its note only costs a row.
      className={cn('flex min-h-0 flex-1 flex-col overflow-auto [grid-area:list] @max-[900px]:flex-row @max-[900px]:gap-1 @max-[900px]:overflow-x-auto @max-[900px]:overflow-y-hidden @max-[900px]:border-t @max-[900px]:border-border @max-[900px]:px-2 @max-[900px]:py-1.5 @max-[900px]:[scrollbar-width:thin]', materialsActive && '@max-[900px]:hidden')}
      role="listbox"
      aria-label={materialsActive ? 'Material overrides' : (editor.mode === 'paint' ? 'Paint layers' : 'Stickers')}
    >
      {editor.perWearScope && (
        // When narrow the list is a single row, so the note keeps a fixed width and wraps inside it.
        <p className={cn(NOTE, '@max-[900px]:mx-2 @max-[900px]:my-1.5 @max-[900px]:w-70 @max-[900px]:flex-none')} data-slot="editor-scope-note">
          Editing {editor.perWearScope.weapon}, {editor.perWearScope.wear} only. Switch in the viewer.
        </p>
      )}
      {materialsActive ? null : editor.mode === 'paint' ? (<>
        {editor.baseLayer && (
          <button
            type="button"
            className={ROW}
            data-slot="editor-layer-row"
            role="option"
            aria-selected={editor.baseLayer.active}
            onClick={editor.baseLayer.onSelect}
          >
            <span className={LAYER_THUMB} aria-hidden="true">
              {editor.baseLayer.thumbnail ? <img className={LAYER_IMAGE} src={editor.baseLayer.thumbnail} alt="" draggable={false} /> : null}
              <span
                className={LAYER_SWATCH}
                style={baseLayerSwatch ? { background: baseLayerSwatch } : undefined}
              />
            </span>
            <span className={LABEL}>{editor.baseLayer.label}</span>
            {(editor.layerHasTransformEdits?.[editor.selectors.length] ?? false) && (
              <span className={VARY_MARK} title="This layer has non-default transform ranges">
                <RefreshCw size={11} aria-hidden="true" />
              </span>
            )}
            {(editor.layerTransformLocked?.[editor.selectors.length] ?? false) && (
              <span className={LOCK_MARK} title="This layer's transforms are locked">
                <Lock size={11} aria-hidden="true" />
              </span>
            )}
            {/* The base layer has no count, but its marks line up with the rows below. Narrow, the rows do not stack. */}
            <span className={cn(COUNT, '@max-[900px]:hidden')} aria-hidden="true" />
          </button>
        )}
        {editor.selectors.map((selector, index) => {
        const active = editor.activeSelectorId === selector.id;
        const swatchColor = editor.layerSwatchColors?.[index] ?? editor.layerColors?.[index];
        const thumbnail = editor.layerThumbnails?.[index];
        const count = editor.groupLayerIndex
          ? Object.values(editor.groupLayerIndex).filter((layerIndex) => layerIndex === index).length
          : 0;
        const hasTransformEdits = editor.layerHasTransformEdits?.[index] ?? false;
        const transformLocked = editor.layerTransformLocked?.[index] ?? false;
        return (
          <button
            type="button"
            key={selector.id}
            className={ROW}
            data-slot="editor-layer-row"
            role="option"
            aria-selected={active}
            onClick={() => editor.onActiveSelectorChange(selector.id)}
          >
            <span className={LAYER_THUMB} aria-hidden="true">
              {thumbnail ? <img className={LAYER_IMAGE} src={thumbnail} alt="" draggable={false} /> : null}
              <span
                className={LAYER_SWATCH}
                style={swatchColor ? { background: swatchColor } : undefined}
              />
            </span>
            <span className={LABEL}>{selector.label}</span>
            {hasTransformEdits && (
              <span className={VARY_MARK} title="This layer has non-default transform ranges">
                <RefreshCw size={11} aria-hidden="true" />
              </span>
            )}
            {transformLocked && (
              <span className={LOCK_MARK} title="This layer's transforms are locked">
                <Lock size={11} aria-hidden="true" />
              </span>
            )}
            <span className={COUNT}>{count}</span>
          </button>
        );
        })}
      </>) : editor.sticker?.targets.map((target, index) => {
        const active = editor.sticker?.activeTargetId === target.id;
        return (
          <button
            type="button"
            key={target.id}
            className={ROW}
            role="option"
            aria-selected={active}
            onClick={() => editor.sticker?.onActiveTargetChange(target.id)}
          >
            <span className={STICKER_THUMB} aria-hidden="true">
              {target.thumbnail ? <img src={target.thumbnail} alt="" draggable={false} /> : null}
            </span>
            <span className={LABEL}>
              {target.label || `Sticker ${index + 1}`}
            </span>
            {(target.variantCount ?? 1) > 1 && (
              <span className={COUNT} title={`${target.variantCount} random variants`}>
                {target.variantCount}
              </span>
            )}
            {(target.sharedWith ?? 0) > 0 && (
              <span
                className={VARY_MARK}
                title={`Shares its image with ${target.sharedWith} other sticker${target.sharedWith === 1 ? '' : 's'}`}
              >
                <Link2 size={11} aria-hidden="true" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
