import type { Dispatch, SetStateAction } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';

export type MobilePanel = 'none' | 'catalog' | 'controls';

interface MobileTabStripProps {
  mobilePanel: MobilePanel;
  setMobilePanel: Dispatch<SetStateAction<MobilePanel>>;
}

export function MobileTabStrip({ mobilePanel, setMobilePanel }: MobileTabStripProps) {
  const toggleMobilePanel = (panel: MobilePanel) => setMobilePanel((current) => (current === panel ? 'none' : panel));

  return (
    <nav className="mobile-tabstrip" aria-label="Panels">
      <button
        type="button"
        className="mobile-tab-btn"
        aria-pressed={mobilePanel === 'catalog'}
        onClick={() => toggleMobilePanel('catalog')}
      >
        <Palette size={18} />
        <span>Warpaints</span>
      </button>
      <button
        type="button"
        className="mobile-tab-btn"
        aria-pressed={mobilePanel === 'none'}
        onClick={() => setMobilePanel('none')}
      >
        <Eye size={18} />
        <span>Viewer</span>
      </button>
      <button
        type="button"
        className="mobile-tab-btn"
        aria-pressed={mobilePanel === 'controls'}
        onClick={() => toggleMobilePanel('controls')}
      >
        <SlidersHorizontal size={18} />
        <span>Controls</span>
      </button>
    </nav>
  );
}
