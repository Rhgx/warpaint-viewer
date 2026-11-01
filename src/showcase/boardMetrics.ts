import type { GridSize } from './showcaseTypes';

// Board size and grid cell sizes, shared by the board and its layout code.
export const BOARD_WIDTH = 200;
export const BOARD_HEIGHT = 112;
export const GRID_CELL: Record<GridSize, number> = { fine: 1.25, normal: 2.5, coarse: 5 };
