import type { PaintkitEntry } from '../../data/types';
import { isCustomKitId, paintkitDefindex } from '../../protodefs/types';
import { useSettings } from '../../settings';
import { useTextureDirectory } from '../../hooks/useTextureDirectory';
import { PaintkitDetailsButton } from '../catalog/PaintkitDetailsButton';

interface StageOverlayProps {
  selectedKit: PaintkitEntry | null;
  showStageHeader: boolean;
  weaponName: string;
  hasCustomFiles: boolean;
  composing: boolean;
  cameraMode: 'inspect' | 'advanced';
}

export function StageOverlay({
  selectedKit,
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
    <div className="stage-overlay-tl">
      {showStageHeader && selectedKit && (
        <div className="stage-header">
          <div className="stage-header-title">
            <div
              className="stage-header-name"
              style={{ color: selectedKit?.grade ? `var(--grade-${selectedKit.grade})` : undefined }}
            >
              {selectedKit.name}
            </div>
            {/* Keyed so a "Copied" notice never carries over to the next kit. */}
            {showPaintkitDetails && (
              <PaintkitDetailsButton
                key={selectedKit.id}
                defindex={paintkitDefindex(selectedKit.id)}
                kitName={selectedKit.name}
                entry={directoryEntry}
                directory={directory}
                side="bottom"
                className="stage-header-info"
              />
            )}
          </div>
          <div className="stage-header-meta">
            {isCustomKitId(selectedKit.id)
              ? weaponName
              : `${selectedKit.collection ?? 'Uncategorized'} - ${weaponName}`}
            {hasCustomFiles ? ' - Custom files' : ''}
          </div>
        </div>
      )}
      {composing && (
        <div className="composing-badge">
          <span className="composing-badge-spinner" aria-hidden="true" />
          <span>Compositing…</span>
        </div>
      )}
      {cameraMode === 'advanced' && (
        <div className="advanced-camera-badge" role="status">
          <span>Advanced Camera</span>
          <span className="advanced-camera-badge-exit">
            <kbd>Alt</kbd> to exit
          </span>
        </div>
      )}
    </div>
  );
}
