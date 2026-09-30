import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import type { Viewer } from '../viewer/Viewer';
import { snapStickerRotationToCardinal, stickerPlacementFromQuad, stickerPlacementToQuad } from './sticker/stickerGeometry';
import { showStickerPreview } from './sticker/stickerPreview';
import { stickerQuadsEqual, type StickerPlacementQuad } from './sticker/viewerStickerPlacement';
import type { EditorCore } from './useEditorCore';
import type { PartsEditor } from './layers/usePartsEditor';
import type { StickerEditor } from './sticker/useStickerEditor';

interface UseEditorViewportOptions extends
  Pick<EditorCore, 'editorPreviewPending' | 'editorDefinitionGeneration' | 'setSessionStickerQuad'>,
  Pick<PartsEditor, 'groupAssignActive' | 'groupPointerRef' | 'setHoverBucket' | 'sampleEditorSurface' | 'toggleEditorGroup'> {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewerRef: React.RefObject<Viewer | null>;
  engineReady: boolean;
  editorTabActive: boolean;
  visibleDefinitionGeneration: number;
  setHintDismissed: Dispatch<SetStateAction<boolean>>;
  sticker: Pick<StickerEditor,
    | 'stickerTransformTool'
    | 'stickerAspectLocked'
    | 'modelPartPickingActive'
    | 'setHiddenModelPartCount'
    | 'selectedStickerTarget'
    | 'selectedStickerUsesComposedArtwork'
    | 'authoredStickerQuad'
    | 'activeGroupStickerResources'
    | 'destinationEditSettling'
    | 'stickerBaseSurfaceKey'
    | 'stickerDraftActive'
    | 'stickerSpecularUrl'
    | 'stickerSurfaceComposeKey'
    | 'effectiveStickerTextureUrl'
    | 'stickerBaseSurfaceResultRef'
    | 'stickerDraftRef'
    | 'stickerGestureRef'
    | 'stickerGizmoGestureRef'
    | 'modelPartPointerRef'
    | 'updateStickerDraft'
    | 'stickerPlacementActive'
    | 'stickerPartPickingActive'
    | 'beginStickerInteraction'
    | 'previewStickerDraft'
  >;
}

/**
 * How the editor talks to the 3D canvas: the camera and selection modes it
 * switches on the viewer, the live sticker preview, and the pointer router
 * that turns canvas gestures into part selection, sticker placement and
 * model-part picking.
 */
export function useEditorViewport({
  editorPreviewPending,
  editorDefinitionGeneration,
  setSessionStickerQuad,
  groupAssignActive,
  groupPointerRef,
  setHoverBucket,
  sampleEditorSurface,
  toggleEditorGroup,
  canvasRef,
  viewerRef,
  engineReady,
  editorTabActive,
  visibleDefinitionGeneration,
  setHintDismissed,
  sticker,
}: UseEditorViewportOptions) {
  const {
    stickerTransformTool,
    stickerAspectLocked,
    modelPartPickingActive,
    setHiddenModelPartCount,
    selectedStickerTarget,
    selectedStickerUsesComposedArtwork,
    authoredStickerQuad,
    activeGroupStickerResources,
    destinationEditSettling,
    stickerBaseSurfaceKey,
    stickerDraftActive,
    stickerSpecularUrl,
    stickerSurfaceComposeKey,
    effectiveStickerTextureUrl,
    stickerBaseSurfaceResultRef,
    stickerDraftRef,
    stickerGestureRef,
    stickerGizmoGestureRef,
    modelPartPointerRef,
    updateStickerDraft,
    stickerPlacementActive,
    stickerPartPickingActive,
    beginStickerInteraction,
    previewStickerDraft,
  } = sticker;
  const [editorSelectionHeld, setEditorSelectionHeld] = useState(false);
  const editorInteractionActive = groupAssignActive || stickerPlacementActive;

  // Paint-area selection deliberately uses Shift + click. Keep free-fly out
  // of this focused workflow and make the modifier state visible through the
  // canvas cursor before the pointer reaches a selectable part.
  useEffect(() => {
    const viewer = viewerRef.current;
    viewer?.setAdvancedCameraAvailable(!editorTabActive);
    viewer?.setEditorSelectionActive(editorInteractionActive);
    viewer?.setStickerPlacementActive(stickerPlacementActive);
    if (!editorInteractionActive) {
      setEditorSelectionHeld(false);
      return;
    }

    const updateSelectionModifier = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setEditorSelectionHeld(event.type === 'keydown');
    };
    const clearSelectionModifier = () => setEditorSelectionHeld(false);
    window.addEventListener('keydown', updateSelectionModifier);
    window.addEventListener('keyup', updateSelectionModifier);
    window.addEventListener('blur', clearSelectionModifier);
    return () => {
      window.removeEventListener('keydown', updateSelectionModifier);
      window.removeEventListener('keyup', updateSelectionModifier);
      window.removeEventListener('blur', clearSelectionModifier);
    };
  }, [editorInteractionActive, editorTabActive, engineReady, stickerPlacementActive, viewerRef]);

  useEffect(() => {
    if (!editorSelectionHeld) setHoverBucket(null);
  }, [editorSelectionHeld, setHoverBucket]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const surface = stickerBaseSurfaceResultRef.current;
    const quad = stickerDraftRef.current ?? authoredStickerQuad;
    const awaitingNormalComposition = !stickerPlacementActive
      && (editorPreviewPending || visibleDefinitionGeneration < editorDefinitionGeneration);
    const canPreview = (stickerPlacementActive || awaitingNormalComposition)
      && (stickerBaseSurfaceKey === stickerSurfaceComposeKey || destinationEditSettling)
      && surface
      && effectiveStickerTextureUrl
      && quad;
    if (canPreview) {
      // Swap the material source before drawing the decal overlay. The base
      // recipe excludes only this sticker, so there is never an old baked
      // position under the live one.
      viewer.setStickerEditorBaseMap(surface.texture);
      showStickerPreview(viewer, quad, {
        groupResources: selectedStickerUsesComposedArtwork ? activeGroupStickerResources : null,
        textureUrl: effectiveStickerTextureUrl,
        specularUrl: stickerSpecularUrl,
        tool: stickerTransformTool,
      });
      if (!stickerPlacementActive || modelPartPickingActive) viewer.setStickerGizmo(null);
    } else if (stickerPlacementActive && authoredStickerQuad && !modelPartPickingActive) {
      viewer.setStickerEditorBaseMap(null);
      viewer.clearStickerPreview();
      viewer.setStickerGizmo(authoredStickerQuad, stickerTransformTool);
    } else {
      viewer.setStickerEditorBaseMap(null);
      viewer.clearStickerPreview();
    }
  }, [
    authoredStickerQuad,
    activeGroupStickerResources,
    editorDefinitionGeneration,
    destinationEditSettling,
    editorPreviewPending,
    engineReady,
    stickerBaseSurfaceKey,
    stickerDraftActive,
    selectedStickerUsesComposedArtwork,
    stickerPlacementActive,
    modelPartPickingActive,
    stickerSpecularUrl,
    stickerSurfaceComposeKey,
    effectiveStickerTextureUrl,
    stickerTransformTool,
    visibleDefinitionGeneration,
    stickerDraftRef,
    stickerBaseSurfaceResultRef,
    viewerRef,
  ]);

  const beginEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (stickerPartPickingActive && event.button === 0 && event.target === canvasRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      groupPointerRef.current = null;
      stickerGestureRef.current = null;
      stickerGizmoGestureRef.current = null;
      updateStickerDraft(null);
      setHoverBucket(null);
      setHintDismissed(true);
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      modelPartPointerRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (stickerPlacementActive && event.button === 0 && event.target === canvasRef.current
      && authoredStickerQuad) {
      const viewer = viewerRef.current;
      const drag = viewer?.beginStickerGizmoDrag(event.clientX, event.clientY, authoredStickerQuad);
      if (drag) {
        event.preventDefault();
        event.stopPropagation();
        // The viewer has the same native-layer reservation as a backstop;
        // make this high-level ownership explicit for later canvas listeners.
        event.nativeEvent.stopImmediatePropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        stickerGizmoGestureRef.current = {
          pointerId: event.pointerId,
          drag,
          preserveAspect: event.shiftKey ? !stickerAspectLocked : stickerAspectLocked,
          base: authoredStickerQuad,
          latest: authoredStickerQuad,
        };
        beginStickerInteraction();
        return;
      }
    }
    if (stickerPlacementActive && event.shiftKey && event.button === 0
      && event.target === canvasRef.current && authoredStickerQuad) {
      const moved = viewerRef.current?.moveStickerQuadToClientPoint(
        authoredStickerQuad,
        event.clientX,
        event.clientY,
      );
      if (!moved) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      stickerGestureRef.current = {
        pointerId: event.pointerId,
        base: authoredStickerQuad,
        latest: moved,
      };
      previewStickerDraft(moved);
      updateStickerDraft(moved);
      return;
    }
    if (!groupAssignActive || !event.shiftKey || event.button !== 0 || event.target !== canvasRef.current) return;
    groupPointerRef.current = { x: event.clientX, y: event.clientY, moved: false };
  }, [authoredStickerQuad, beginStickerInteraction, groupAssignActive, groupPointerRef, modelPartPointerRef, previewStickerDraft, setHoverBucket, stickerAspectLocked, stickerGestureRef, stickerGizmoGestureRef, stickerPartPickingActive, stickerPlacementActive, updateStickerDraft, canvasRef, setHintDismissed, viewerRef]);

  const previewEditorSurface = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modelPartGesture = modelPartPointerRef.current;
    if (modelPartGesture && modelPartGesture.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - modelPartGesture.x, event.clientY - modelPartGesture.y) > 4) {
        modelPartGesture.moved = true;
      }
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      return;
    }
    if (stickerPartPickingActive && event.target === canvasRef.current) {
      const pick = viewerRef.current?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      viewerRef.current?.setModelPartHover(pick);
      return;
    }
    const gizmoGesture = stickerGizmoGestureRef.current;
    if (gizmoGesture && gizmoGesture.pointerId === event.pointerId) {
      const result = viewerRef.current?.updateStickerGizmoDrag(
        gizmoGesture.drag,
        event.clientX,
        event.clientY,
        gizmoGesture.preserveAspect,
      );
      if (result) {
        let nextQuad = result.quad;
        if (result.intent === 'rotate' && !event.shiftKey) {
          const read = stickerPlacementFromQuad(result.quad);
          if (read.editable && read.placement) {
            nextQuad = stickerPlacementToQuad({
              ...read.placement,
              rotation: snapStickerRotationToCardinal(read.placement.rotation),
            }) ?? result.quad;
          }
        }
        gizmoGesture.latest = nextQuad;
        previewStickerDraft(nextQuad);
        updateStickerDraft(nextQuad);
      }
      return;
    }
    const stickerGesture = stickerGestureRef.current;
    if (stickerGesture && stickerGesture.pointerId === event.pointerId) {
      const moved = viewerRef.current?.moveStickerQuadToClientPoint(
        stickerGesture.base,
        event.clientX,
        event.clientY,
      );
      if (moved) {
        stickerGesture.latest = moved;
        previewStickerDraft(moved);
        updateStickerDraft(moved);
      }
      return;
    }
    if (!groupAssignActive || event.target !== canvasRef.current) return;
    if (!event.shiftKey) {
      groupPointerRef.current = null;
      setHoverBucket(null);
      return;
    }
    const start = groupPointerRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true;
    sampleEditorSurface(event.clientX, event.clientY);
  }, [groupAssignActive, groupPointerRef, modelPartPointerRef, previewStickerDraft, sampleEditorSurface, setHoverBucket, stickerGestureRef, stickerGizmoGestureRef, stickerPartPickingActive, updateStickerDraft, canvasRef, viewerRef]);

  // Ends a sticker drag: release the pointer, then commit its quad when it
  // moved and the target is editable, otherwise drop the local draft.
  const endStickerGesture = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    gesture: { base: StickerPlacementQuad; latest: StickerPlacementQuad },
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!stickerQuadsEqual(gesture.latest, gesture.base)
      && selectedStickerTarget?.editable) {
      if (!setSessionStickerQuad(selectedStickerTarget.target, gesture.latest)) updateStickerDraft(null);
    } else {
      updateStickerDraft(null);
    }
  }, [selectedStickerTarget, setSessionStickerQuad, updateStickerDraft]);

  const finishEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modelPartGesture = modelPartPointerRef.current;
    if (modelPartGesture && modelPartGesture.pointerId === event.pointerId) {
      const moved = modelPartGesture.moved
        || Math.hypot(event.clientX - modelPartGesture.x, event.clientY - modelPartGesture.y) > 4;
      const viewer = viewerRef.current;
      modelPartPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      const pick = viewer?.pickModelPartAt(event.clientX, event.clientY) ?? null;
      const count = !moved && event.button === 0 && pick ? viewer?.toggleModelPart(pick) : null;
      if (count !== null && count !== undefined) setHiddenModelPartCount(count);
      viewer?.setModelPartHover(stickerPartPickingActive ? pick : null);
      return;
    }
    const gizmoGesture = stickerGizmoGestureRef.current;
    if (gizmoGesture && gizmoGesture.pointerId === event.pointerId) {
      stickerGizmoGestureRef.current = null;
      endStickerGesture(event, gizmoGesture);
      return;
    }
    const stickerGesture = stickerGestureRef.current;
    if (stickerGesture && stickerGesture.pointerId === event.pointerId) {
      stickerGestureRef.current = null;
      endStickerGesture(event, stickerGesture);
      return;
    }
    const start = groupPointerRef.current;
    groupPointerRef.current = null;
    if (!groupAssignActive || !event.shiftKey || !start || start.moved || event.button !== 0 || event.target !== canvasRef.current) return;
    const sampled = sampleEditorSurface(event.clientX, event.clientY);
    if (sampled && sampled.bucket > 0) toggleEditorGroup(sampled.bucket);
  }, [endStickerGesture, groupAssignActive, groupPointerRef, modelPartPointerRef, sampleEditorSurface, setHiddenModelPartCount, stickerGestureRef, stickerGizmoGestureRef, stickerPartPickingActive, toggleEditorGroup, canvasRef, viewerRef]);

  const cancelEditorPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    groupPointerRef.current = null;
    if (modelPartPointerRef.current?.pointerId === event.pointerId) {
      modelPartPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      viewerRef.current?.clearModelPartHover();
    }
    if (stickerGizmoGestureRef.current?.pointerId === event.pointerId) {
      stickerGizmoGestureRef.current = null;
      updateStickerDraft(null);
    }
    if (stickerGestureRef.current?.pointerId === event.pointerId) {
      stickerGestureRef.current = null;
      updateStickerDraft(null);
    }
  }, [groupPointerRef, modelPartPointerRef, stickerGestureRef, stickerGizmoGestureRef, updateStickerDraft, viewerRef]);

  const canvasHandlers = {
    onPointerDownCapture: beginEditorPointer,
    onPointerMoveCapture: previewEditorSurface,
    onPointerUpCapture: finishEditorPointer,
    onPointerCancelCapture: cancelEditorPointer,
    onPointerLeave: () => {
      groupPointerRef.current = null;
      if (!modelPartPointerRef.current) viewerRef.current?.clearModelPartHover();
      if (groupAssignActive) setHoverBucket(null);
    },
  };

  return { editorSelectionHeld, editorInteractionActive, canvasHandlers };
}
