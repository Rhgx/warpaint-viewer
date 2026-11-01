import { Expand, Move, RotateCw } from 'lucide-react';

import type { StickerCorner, StickerEdge, StickerPlacement, StickerPoint } from '../../editor/sticker/stickerGeometry';
import type { StickerViewport } from '../../editor/sticker/stickerViewport';

export type StickerPlacementChangeReason = 'move' | 'resize' | 'rotate' | 'nudge' | 'value' | 'fit';
export type StickerTransformTool = 'move' | 'scale' | 'turn';

export interface StickerSelectionTarget {
  readonly id: string;
  readonly label: string;
  readonly placement: StickerPlacement;
}

export type PointerInteraction =
  | { readonly kind: 'move'; readonly initial: StickerPlacement; readonly pointer: StickerPoint }
  | { readonly kind: 'resize'; readonly initial: StickerPlacement; readonly corner: StickerCorner; readonly preserveAspect: boolean }
  | { readonly kind: 'resize-axis'; readonly initial: StickerPlacement; readonly edge: StickerEdge; readonly preserveAspect: boolean }
  | { readonly kind: 'rotate'; readonly initial: StickerPlacement }
  | { readonly kind: 'pan'; readonly initial: StickerViewport; readonly pointer: StickerPoint };

export const CORNERS: readonly StickerCorner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
export const EDGES: readonly StickerEdge[] = ['top', 'right', 'bottom', 'left'];
export const TOOLS: readonly { readonly id: StickerTransformTool; readonly label: string; readonly Icon: typeof Move }[] = [
  { id: 'move', label: 'Move', Icon: Move },
  { id: 'scale', label: 'Scale', Icon: Expand },
  { id: 'turn', label: 'Turn', Icon: RotateCw },
];
export const TOOL_SHORTCUTS: Partial<Record<string, StickerTransformTool>> = { '1': 'move', '2': 'scale', '3': 'turn' };

export const CORNER_ROWS = [
  { corner: 'tl' as const, label: 'Top left', short: 'TL', x: 'tlX' as const, y: 'tlY' as const, field: 'dest_tl' },
  { corner: 'tr' as const, label: 'Top right', short: 'TR', x: 'trX' as const, y: 'trY' as const, field: 'dest_tr' },
  { corner: 'bl' as const, label: 'Bottom left', short: 'BL', x: 'blX' as const, y: 'blY' as const, field: 'dest_bl' },
];
