import type { ComponentProps, Dispatch, RefObject, SetStateAction } from 'react';

import type { useEditorViewport } from '../editor/useEditorViewport';
import type { useScreenshotActions } from '../hooks/useScreenshotActions';
import { TURNTABLE_FORMATS } from '../export/turntableFormats';
import type { useTextureOverrides } from './useTextureOverrides';
import type { useTurntableCapture } from './useTurntableCapture';
import type { useWorkspace } from './useWorkspace';
import type { ControlsState } from '../viewer/controls';
import { CUSTOM_LIGHTING_ID } from '../viewer/lighting/customLightingModel';
import type { Viewer } from '../viewer/Viewer';
import type { WorkbenchTab } from '../workbench/types';
import { DefinitionsPrompt } from '../ui/workbench/DefinitionsPrompt';
import { LightingPanel } from '../ui/lighting/LightingPanel';
import { CanvasHint } from '../ui/stage/CanvasHint';
import { StageOverlay } from '../ui/stage/StageOverlay';
import { StageToolbar } from '../ui/stage/StageToolbar';
import { SupportLink } from '../ui/stage/SupportLink';

// Presentational: every value and handler comes from MainApp, so this component holds no state.
interface StageCanvasProps {
  canvasHandlers: ReturnType<typeof useEditorViewport>['canvasHandlers'];
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewerRef: RefObject<Viewer | null>;
  promptedCandidate: ReturnType<typeof useWorkspace>['promptedCandidate'];
  candidateKey: ReturnType<typeof useWorkspace>['candidateKey'];
  setAnsweredCandidateKey: ReturnType<typeof useWorkspace>['setAnsweredCandidateKey'];
  setWorkbenchTab: Dispatch<SetStateAction<WorkbenchTab>>;
  hintDismissed: boolean;
  setHintDismissed: Dispatch<SetStateAction<boolean>>;
  firstPersonActive: boolean;
  firstPersonBarSlot: (element: HTMLElement | null) => void;
  selectedKit: ComponentProps<typeof StageOverlay>['selectedKit'];
  showStageHeader: ComponentProps<typeof StageOverlay>['showStageHeader'];
  weaponName: ComponentProps<typeof StageOverlay>['weaponName'];
  manualTextureOverrides: ReturnType<typeof useTextureOverrides>['manualTextureOverrides'];
  composing: ComponentProps<typeof StageOverlay>['composing'];
  cameraMode: ComponentProps<typeof StageOverlay>['cameraMode'];
  paintkits: ComponentProps<typeof StageOverlay>['paintkits'];
  onSelectKit: ComponentProps<typeof StageOverlay>['onSelectKit'];
  workbenchOpen: ComponentProps<typeof StageToolbar>['workbenchOpen'];
  editingMode: ComponentProps<typeof StageToolbar>['editingMode'];
  preloadWorkbench: ComponentProps<typeof StageToolbar>['onPreloadWorkbench'];
  toggleWorkbench: ComponentProps<typeof StageToolbar>['onToggleWorkbench'];
  captureFormat: ComponentProps<typeof StageToolbar>['captureFormat'];
  state: ControlsState;
  startTurntableCapture: ReturnType<typeof useTurntableCapture>['startTurntableCapture'];
  onScreenshot: ReturnType<typeof useScreenshotActions>['saveImage'];
  onCopyImage: ComponentProps<typeof StageToolbar>['onCopyImage'];
  autoSpin: boolean;
  setAutoSpin: Dispatch<SetStateAction<boolean>>;
  showcaseOpen: boolean;
  setShowcaseOpen: Dispatch<SetStateAction<boolean>>;
  lightingStore: ComponentProps<typeof LightingPanel>['store'];
  editorInteractionActive: ComponentProps<typeof CanvasHint>['editorInteractionActive'];
  editorSelectionHeld: boolean;
  stickerPartPickingActive: ComponentProps<typeof CanvasHint>['stickerPartPickingActive'];
  stickerEditorPreparing: ComponentProps<typeof CanvasHint>['stickerEditorPreparing'];
  stickerPlacementActive: ComponentProps<typeof CanvasHint>['stickerPlacementActive'];
  stickerTransformTool: ComponentProps<typeof CanvasHint>['stickerTransformTool'];
  groupAssignActive: ComponentProps<typeof CanvasHint>['groupAssignActive'];
}

export function StageCanvas({
  canvasHandlers,
  canvasRef,
  viewerRef,
  promptedCandidate,
  candidateKey,
  setAnsweredCandidateKey,
  setWorkbenchTab,
  hintDismissed,
  setHintDismissed,
  firstPersonActive,
  firstPersonBarSlot,
  selectedKit,
  showStageHeader,
  weaponName,
  manualTextureOverrides,
  composing,
  cameraMode,
  paintkits,
  onSelectKit,
  workbenchOpen,
  editingMode,
  preloadWorkbench,
  toggleWorkbench,
  captureFormat,
  state,
  startTurntableCapture,
  onScreenshot,
  onCopyImage,
  autoSpin,
  setAutoSpin,
  showcaseOpen,
  setShowcaseOpen,
  lightingStore,
  editorInteractionActive,
  editorSelectionHeld,
  stickerPartPickingActive,
  stickerEditorPreparing,
  stickerPlacementActive,
  stickerTransformTool,
  groupAssignActive,
}: StageCanvasProps) {
  return (
    <div
      className="stage-backplate relative min-h-0 flex-1 overflow-hidden bg-stage"
      data-prompt={promptedCandidate ? '' : undefined}
      data-editor-selecting={editorInteractionActive && editorSelectionHeld ? '' : undefined}
      data-model-part-picking={stickerPartPickingActive ? '' : undefined}
      {...canvasHandlers}
      onPointerDown={() => setHintDismissed(true)}
      onWheel={() => setHintDismissed(true)}
    >
      <canvas ref={canvasRef} className="relative z-1 block size-full in-data-editor-selecting:cursor-crosshair in-data-model-part-picking:cursor-crosshair" />
      {firstPersonActive && <div className="absolute inset-0 z-2" aria-hidden="true" />}
      <StageOverlay
        selectedKit={selectedKit}
        showStageHeader={showStageHeader}
        weaponName={weaponName}
        hasCustomFiles={Object.keys(manualTextureOverrides).length > 0}
        composing={composing}
        cameraMode={cameraMode}
        paintkits={paintkits}
        onSelectKit={onSelectKit}
      />
      <StageToolbar
        workbenchOpen={workbenchOpen}
        editingMode={editingMode}
        onPreloadWorkbench={preloadWorkbench}
        onToggleWorkbench={toggleWorkbench}
        captureFormat={captureFormat}
        saveLabel={captureFormat === 'image' ? 'Save PNG' : `Save ${TURNTABLE_FORMATS[state.turntableFormat].label}`}
        onSave={captureFormat === 'animated' ? startTurntableCapture : onScreenshot}
        onCopyImage={onCopyImage}
        onResetView={() => viewerRef.current?.resetView()}
        autoSpin={autoSpin}
        onToggleAutoSpin={() => setAutoSpin((spinning) => !spinning)}
        showAutoSpin={!firstPersonActive}
        showcaseOpen={showcaseOpen}
        onToggleShowcase={() => setShowcaseOpen((open) => !open)}
      />
      {state.preset === CUSTOM_LIGHTING_ID && (
        <LightingPanel store={lightingStore} />
      )}
      {!firstPersonActive && (
        <CanvasHint
          dismissed={hintDismissed}
          editorInteractionActive={editorInteractionActive}
          stickerEditorPreparing={stickerEditorPreparing}
          stickerPartPickingActive={stickerPartPickingActive}
          stickerPlacementActive={stickerPlacementActive}
          stickerTransformTool={stickerTransformTool}
          groupAssignActive={groupAssignActive}
        />
      )}
      {!editingMode && <SupportLink />}
      {firstPersonActive && (
        // Takes the hint's slot and steps above the definitions prompt the same way. The side padding clears the
        // Support link, and the bar's contents answer to the width that is left. An open mobile panel covers it.
        <div
          ref={firstPersonBarSlot}
          data-slot="first-person-bar-slot"
          className="@container pointer-events-none absolute inset-x-0 bottom-2.5 z-2 flex justify-center px-36 in-data-prompt:bottom-15.5 mobile:bottom-1 mobile:in-data-prompt:bottom-15.5 mobile:pr-[calc(10px+env(safe-area-inset-right))] mobile:pl-[calc(10px+env(safe-area-inset-left))] mobile:not-in-data-[mobile-panel=none]:invisible"
        />
      )}
      {promptedCandidate && (
        <DefinitionsPrompt
          path={promptedCandidate.path}
          onImport={() => {
            promptedCandidate.onLoad();
            // Land on the tab that shows the import, whether or not the drawer is open.
            setWorkbenchTab('definitions');
            setAnsweredCandidateKey(candidateKey);
          }}
          onDismiss={() => setAnsweredCandidateKey(candidateKey)}
        />
      )}
    </div>
  );
}
