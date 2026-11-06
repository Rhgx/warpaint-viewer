import type { PaintkitEntry } from '../../data/types';
import { isCustomKitId, paintkitDefindex } from '../../protodefs/types';
import { useSettings } from '../../settings';
import { useTextureDirectory } from '../../hooks/useTextureDirectory';
import { PaintkitDetailsButton } from '../catalog/PaintkitDetailsButton';
import { Kbd } from '../primitives/Kbd';
import { cn } from '../primitives/cn';

const BADGE = 'pointer-events-auto flex items-center rounded-md border border-strong bg-panel px-2.5 py-1 text-11 shadow-pop';

interface StageOverlayProps {
  selectedKit: PaintkitEntry | null;
  showStageHeader: boolean;
  weaponName: string;
  hasCustomFiles: boolean;
  composing: boolean;
  cameraMode: 'inspect' | 'advanced';
  paintkits: readonly PaintkitEntry[];
  onSelectKit: (id: number) => void;
}

export function StageOverlay({
  selectedKit,
  paintkits,
  onSelectKit,
  showStageHeader,
  weaponName,
  hasCustomFiles,
  composing,
  cameraMode,
}: StageOverlayProps) {
  const showPaintkitDetails = useSettings((s) => s.showPaintkitDetails);
  const directory = useTextureDirectory();
  // Imported kits are excluded: Pyxell's entry describes the stock paint.
  const directoryEntry = directory && selectedKit && !isCustomKitId(selectedKit.id)
    ? directory.entries[selectedKit.id]
    : undefined;
  return (
    // pointer-events-none keeps orbit and zoom working under it. Mobile: moved below the toolbar, by its height plus a gap.
    <div className="pointer-events-none absolute top-2.5 left-2.5 z-2 flex max-w-[min(60%,420px)] flex-col items-start gap-1.5 mobile:top-[calc(env(safe-area-inset-top)+var(--stage-toolbar-btn)+24px)] mobile:left-[calc(10px+env(safe-area-inset-left))] mobile:max-w-[calc(100%-20px-env(safe-area-inset-left)-env(safe-area-inset-right))]">
      {showStageHeader && selectedKit && (
        // Light text and a shadow stay legible on the always-dark canvas. An open mobile sheet leaves too little canvas for it.
        <div className="mobile:not-in-data-[mobile-panel=none]:hidden [text-shadow:0_1px_2px_rgb(0_0_0/70%),0_2px_10px_rgb(0_0_0/40%)]">
          <div className="flex max-w-full items-baseline gap-1.75" data-slot="stage-paint-name">
            <div
              className="max-w-full min-w-0 truncate text-15 leading-[1.25] font-bold text-on-canvas"
              style={{ color: selectedKit?.grade ? `var(--grade-${selectedKit.grade})` : undefined }}
            >
              {selectedKit.name}
            </div>
            {/* Keyed so a "Copied" notice never carries over to the next kit. The overlay ignores pointer input so the stage stays draggable; this button is the one exception. */}
            {showPaintkitDetails && (
              <PaintkitDetailsButton
                key={selectedKit.id}
                defindex={paintkitDefindex(selectedKit.id)}
                kitName={selectedKit.name}
                entry={directoryEntry}
                directory={directory}
                paintkits={paintkits}
                onSelectKit={onSelectKit}
                side="bottom"
                className="pointer-events-auto self-center text-on-canvas/62"
                stockKit={!isCustomKitId(selectedKit.id)}
              />
            )}
          </div>
          <div className="mt-px max-w-full truncate text-11 tracking-[0.2px] text-on-canvas/74">
            {isCustomKitId(selectedKit.id)
              ? weaponName
              : `${selectedKit.collection ?? 'Uncategorized'} - ${weaponName}`}
            {hasCustomFiles ? ' - Custom files' : ''}
          </div>
        </div>
      )}
      {composing && (
        <div data-slot="composing-badge" className={cn(BADGE, 'gap-1.5 text-dim')}>
          <span className="size-3 flex-none animate-spin rounded-full border-2 border-strong border-t-accent motion-reduce:animate-none" aria-hidden="true" />
          <span>Compositing…</span>
        </div>
      )}
      {cameraMode === 'advanced' && (
        <div data-slot="advanced-camera-badge" className={cn(BADGE, 'gap-2 text-text')} role="status">
          <span>Advanced Camera</span>
          <span className="flex items-center gap-1 border-l border-border pl-2 text-dim">
            <Kbd>Alt</Kbd> to exit
          </span>
        </div>
      )}
    </div>
  );
}
