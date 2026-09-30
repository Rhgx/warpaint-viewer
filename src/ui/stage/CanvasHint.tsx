import type { StickerTransformTool } from '../workbench/StickerPlacementEditor';

interface CanvasHintProps {
  dismissed: boolean;
  editorInteractionActive: boolean;
  stickerEditorPreparing: boolean;
  stickerPartPickingActive: boolean;
  stickerPlacementActive: boolean;
  stickerTransformTool: StickerTransformTool;
  groupAssignActive: boolean;
}

function hintText({
  stickerPartPickingActive,
  stickerEditorPreparing,
  stickerPlacementActive,
  stickerTransformTool,
  groupAssignActive,
}: CanvasHintProps): string {
  if (stickerPartPickingActive) {
    return 'click a part to hide it, click its outline to bring it back; Esc leaves, middle rotates, right pans';
  }
  if (stickerEditorPreparing) return 'Preparing sticker editor…';
  if (stickerPlacementActive) {
    return stickerTransformTool === 'move'
      ? 'drag the sticker to move it; Shift places, middle rotates / double-click resets, right pans'
      : stickerTransformTool === 'scale'
        ? 'drag a scale handle; Shift places, middle rotates / double-click resets, right pans'
        : 'drag the turn handle; Shift places, middle rotates / double-click resets, right pans';
  }
  if (groupAssignActive) return 'hold Shift to preview and select parts, drag to rotate';
  return 'drag to rotate, scroll to zoom, right-drag to pan, double-click to reset';
}

export function CanvasHint(props: CanvasHintProps) {
  const { dismissed, editorInteractionActive, stickerEditorPreparing, stickerPartPickingActive } = props;
  return (
    <div className={`canvas-hint${dismissed && !editorInteractionActive && !stickerEditorPreparing && !stickerPartPickingActive ? ' dismissed' : ''}`}>
      {hintText(props)}
    </div>
  );
}
