import { ChevronLeft, ChevronRight } from 'lucide-react';

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
  // Points the way the panel moves: outward to collapse, inward to reopen. CSS rotates it when docked.
  const pointsLeft = side === 'left' ? open : !open;
  const Icon = pointsLeft ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      className="panel-edge-toggle"
      data-side={side}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon size={17} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}
