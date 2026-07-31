import { ChevronLeft, ChevronRight } from 'lucide-react';

// Collapse handle mounted on the stage's own left/right edge, which is exactly
// where the neighbouring panel ends. Living inside the stage rather than being
// pinned to a panel means the handle survives the panel collapsing to zero
// width, and it rides the grid transition without needing the width variables.
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
  // Points the way the panel will move: outwards to collapse, inwards to bring
  // it back. The bottom-docked layout rotates this in CSS.
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
