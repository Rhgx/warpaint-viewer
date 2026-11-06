import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '../primitives/cn';

// The edges facing the stage are lifted towards the dim text to clear 3:1 on the dark backdrop, and the chevron
// uses it in full, since this is the only way to reopen a collapsed panel. ::before pads the pointer target past
// the 24px minimum, growing only into the stage. Forced colors collapse the panel tokens, so it takes system colors.
const TOGGLE = 'absolute top-1/2 z-3 flex h-18 w-5 -translate-y-1/2 cursor-pointer items-center justify-center border border-[color-mix(in_srgb,var(--border-strong)_60%,var(--text-dim))] bg-panel p-0 text-dim transition-fast focus-ring before:absolute before:inset-y-0 hover:bg-panel-2 hover:text-text mobile:hidden forced-colors:border-[ButtonBorder] forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText]';
const LEFT = 'left-0 rounded-r-md border-l-0 before:right-[-6px] before:left-0';
// Docked, the inspector sits under the stage, so its handle follows the stage's bottom edge and lies flat.
const RIGHT = 'right-0 rounded-l-md border-r-0 before:right-0 before:left-[-6px] docked:top-auto docked:right-4 docked:bottom-0 docked:h-5 docked:w-18 docked:translate-y-0 docked:rounded-t-md docked:rounded-b-none docked:border-r docked:border-b-0 docked:before:inset-x-0 docked:before:top-[-6px]';

// Collapse handle on the stage's own edge, where the neighbouring panel ends. Living in the stage
// (not the panel) lets it survive the panel collapsing to zero width and ride the grid transition.
export function PanelEdgeToggle({
  side,
  open,
  label,
  controls,
  onToggle,
}: {
  side: 'left' | 'right';
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  // Points the way the panel moves: outward to collapse, inward to reopen. Rotated when docked.
  const pointsLeft = side === 'left' ? open : !open;
  const Icon = pointsLeft ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      className={cn(TOGGLE, side === 'left' ? LEFT : RIGHT)}
      data-slot="panel-edge-toggle"
      data-side={side}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon className={side === 'right' ? 'docked:rotate-90' : undefined} size={17} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}
