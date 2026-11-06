import type { Dispatch, SetStateAction } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';

import { cn } from '../primitives/cn';

export type MobilePanel = 'none' | 'catalog' | 'controls';

interface MobileTabStripProps {
  mobilePanel: MobilePanel;
  setMobilePanel: Dispatch<SetStateAction<MobilePanel>>;
}

const TAB = 'flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent px-0 py-1.5 text-10 tracking-[0.2px] text-dim transition-fast aria-pressed:text-accent mobile-landscape:flex-row mobile-landscape:gap-1.5 mobile-landscape:py-0 mobile-landscape:text-11';

export function MobileTabStrip({ mobilePanel, setMobilePanel }: MobileTabStripProps) {
  const toggleMobilePanel = (panel: MobilePanel) => setMobilePanel((current) => (current === panel ? 'none' : panel));

  return (
    <>
      {/* Shown only behind the portrait catalog sheet; a tap above the
          sheet closes it. The Viewer tab is the keyboard route. */}
      <div
        className={cn(
          'fixed inset-0 z-39 hidden bg-black/45 phone-portrait:block',
          mobilePanel === 'catalog' ? 'visible opacity-100 [transition:opacity_220ms_ease]' : 'invisible opacity-0 [transition:opacity_220ms_ease,visibility_0s_linear_220ms]',
        )}
        aria-hidden="true"
        onClick={() => setMobilePanel('none')}
      />
      <nav
        className="fixed inset-x-0 bottom-0 z-60 hidden h-(--mobile-tabstrip-bottom) border-t border-border bg-panel pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] mobile:flex"
        aria-label="Panels"
      >
        <button
          type="button"
          className={TAB}
          data-slot="mobile-tab"
          aria-pressed={mobilePanel === 'catalog'}
          onClick={() => toggleMobilePanel('catalog')}
        >
          <Palette size={18} />
          <span>Warpaints</span>
        </button>
        <button
          type="button"
          className={TAB}
          data-slot="mobile-tab"
          aria-pressed={mobilePanel === 'none'}
          onClick={() => setMobilePanel('none')}
        >
          <Eye size={18} />
          <span>Viewer</span>
        </button>
        <button
          type="button"
          className={TAB}
          data-slot="mobile-tab"
          aria-pressed={mobilePanel === 'controls'}
          onClick={() => toggleMobilePanel('controls')}
        >
          <SlidersHorizontal size={18} />
          <span>Controls</span>
        </button>
      </nav>
    </>
  );
}
