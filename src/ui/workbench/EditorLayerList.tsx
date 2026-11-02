import { Link2, Lock, RefreshCw } from 'lucide-react';
import type { WorkbenchEditor } from './workbenchTypes';

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
      className="custom-workbench-edit-list"
      data-materials={materialsActive ? '' : undefined}
      role="listbox"
      aria-label={materialsActive ? 'Material overrides' : (editor.mode === 'paint' ? 'Paint layers' : 'Stickers')}
    >
      {editor.perWearScope && (
        <p className="custom-workbench-edit-scope-note">
          Editing: {editor.perWearScope.weapon}, {editor.perWearScope.wear}. This paint has a separate operation for each weapon and wear; change the weapon or wear in the viewer to edit another.
        </p>
      )}
      {materialsActive ? (
        <p className="custom-workbench-edit-materials-note">
          Material overrides apply to the whole paint, so this list is not used in Materials.
        </p>
      ) : editor.mode === 'paint' ? (<>
        {editor.baseLayer && (
          <button
            type="button"
            className="custom-workbench-edit-layer-row"
            role="option"
            aria-selected={editor.baseLayer.active}
            onClick={editor.baseLayer.onSelect}
          >
            <span className="custom-workbench-edit-layer-thumb" aria-hidden="true">
              {editor.baseLayer.thumbnail ? <img src={editor.baseLayer.thumbnail} alt="" draggable={false} /> : null}
              <span
                className="custom-workbench-edit-layer-swatch"
                style={baseLayerSwatch ? { background: baseLayerSwatch } : undefined}
              />
            </span>
            <span className="custom-workbench-edit-layer-label">{editor.baseLayer.label}</span>
            {(editor.layerHasTransformEdits?.[editor.selectors.length] ?? false) && (
              <span className="custom-workbench-edit-layer-vary" title="This layer has non-default transform ranges">
                <RefreshCw size={11} aria-hidden="true" />
              </span>
            )}
            {(editor.layerTransformLocked?.[editor.selectors.length] ?? false) && (
              <span className="custom-workbench-edit-layer-lock" title="This layer's transforms are locked">
                <Lock size={11} aria-hidden="true" />
              </span>
            )}
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
            className="custom-workbench-edit-layer-row"
            role="option"
            aria-selected={active}
            onClick={() => editor.onActiveSelectorChange(selector.id)}
          >
            <span className="custom-workbench-edit-layer-thumb" aria-hidden="true">
              {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : null}
              <span
                className="custom-workbench-edit-layer-swatch"
                style={swatchColor ? { background: swatchColor } : undefined}
              />
            </span>
            <span className="custom-workbench-edit-layer-label">{selector.label}</span>
            {hasTransformEdits && (
              <span className="custom-workbench-edit-layer-vary" title="This layer has non-default transform ranges">
                <RefreshCw size={11} aria-hidden="true" />
              </span>
            )}
            {transformLocked && (
              <span className="custom-workbench-edit-layer-lock" title="This layer's transforms are locked">
                <Lock size={11} aria-hidden="true" />
              </span>
            )}
            <span className="custom-workbench-edit-layer-count">{count}</span>
          </button>
        );
        })}
      </>) : editor.sticker?.targets.map((target, index) => {
        const active = editor.sticker?.activeTargetId === target.id;
        return (
          <button
            type="button"
            key={target.id}
            className="custom-workbench-edit-sticker-row"
            role="option"
            aria-selected={active}
            onClick={() => editor.sticker?.onActiveTargetChange(target.id)}
          >
            <span className="custom-workbench-edit-sticker-thumb" aria-hidden="true">
              {target.thumbnail ? <img src={target.thumbnail} alt="" draggable={false} /> : null}
            </span>
            <span className="custom-workbench-edit-sticker-label">
              {target.label || `Sticker ${index + 1}`}
            </span>
            {(target.variantCount ?? 1) > 1 && (
              <span className="custom-workbench-edit-layer-count" title={`${target.variantCount} random variants`}>
                {target.variantCount}
              </span>
            )}
            {(target.sharedWith ?? 0) > 0 && (
              <span
                className="custom-workbench-edit-layer-vary"
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
