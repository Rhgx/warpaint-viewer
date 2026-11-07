import { TOUCH_ONLY_DEVICE } from '../../device';
import { cn } from '../primitives/cn';
import type { StickerTransformTool } from '../editor/stickerPlacementEditorTypes';

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
    return 'Click a part to hide it, click its outline to bring it back; Esc leaves, middle rotates, right pans';
  }
  if (stickerEditorPreparing) return 'Preparing sticker editor…';
  if (stickerPlacementActive) {
    return stickerTransformTool === 'move'
      ? 'Drag the sticker to move it; Shift places, middle rotates / double-click resets, right pans'
      : stickerTransformTool === 'scale'
        ? 'Drag a scale handle; Shift places, middle rotates / double-click resets, right pans'
        : 'Drag the turn handle; Shift places, middle rotates / double-click resets, right pans';
  }
  if (groupAssignActive) return 'Hold Shift to preview and select parts, drag to rotate';
  if (TOUCH_ONLY_DEVICE) return 'Drag to rotate, pinch to zoom, twist to roll, two fingers to move, double-tap to reset';
  return 'Drag to rotate, scroll to zoom, right-drag to pan, double-click to reset';
}

export function CanvasHint(props: CanvasHintProps) {
  const { dismissed, editorInteractionActive, stickerEditorPreparing, stickerPartPickingActive } = props;
  // A word joiner after each hyphen, so that a wrapping hint keeps "double-tap" whole.
  const text = hintText(props).replaceAll('-', '-\u2060');
  return (
    <div
      data-slot="canvas-hint"
      className={cn(
        // The definitions prompt takes the bottom-center slot, so the hint steps above it. An open mobile panel covers the hint's slot.
        'pointer-events-none absolute bottom-2.5 left-1/2 z-2 -translate-x-1/2 rounded-sm border border-border bg-panel/88 px-3.5 py-1 text-10.5 tracking-[0.2px] whitespace-nowrap text-dim shadow-pop backdrop-blur-[6px] touch:backdrop-blur-none transition-opacity duration-200 ease-[ease] select-none in-data-prompt:bottom-15.5 mobile:w-max mobile:max-w-[calc(100%-24px)] mobile:text-center mobile:text-12 mobile:whitespace-normal mobile:not-in-data-[mobile-panel=none]:invisible mobile:not-in-data-[mobile-panel=none]:opacity-0',
        dismissed && !editorInteractionActive && !stickerEditorPreparing && !stickerPartPickingActive && 'opacity-0',
      )}
    >
      {text}
    </div>
  );
}
