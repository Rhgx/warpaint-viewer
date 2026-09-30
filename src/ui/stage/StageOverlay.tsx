import type { PaintkitEntry } from '../../data/types';
import { isCustomKitId } from '../../protodefs/types';

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
  return (
    <div className="stage-overlay-tl">
      {showStageHeader && selectedKit && (
        <div className="stage-header">
          <div
            className="stage-header-name"
            style={{ color: selectedKit?.grade ? `var(--grade-${selectedKit.grade})` : undefined }}
          >
            {selectedKit.name}
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
