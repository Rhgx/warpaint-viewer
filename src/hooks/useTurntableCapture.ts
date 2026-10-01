import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ControlsState } from '../viewer/controls';
import type { TurntableFormat } from '../export/turntable.worker';
import { formatSize } from '../ui/common/formatSize';
import { TURNTABLE_FORMATS, supportedTurntableFormats } from './useScreenshotActions';
import type { TurntableStatus } from './useScreenshotActions';

/** Abort reason for the toast's Cancel button; any other stop offers a retry. */
const TURNTABLE_CANCELLED = 'Cancelled';

/** Rough remaining time once enough frames have been timed to trust the rate. */
function turntableTimeLeft(done: number, frames: number, since: { at: number; done: number } | null): string | null {
  if (!since) return null;
  const elapsed = (performance.now() - since.at) / 1000;
  if (done < Math.max(5, frames * 0.05) || elapsed < 1 || done <= since.done) return null;
  const seconds = (elapsed / (done - since.done)) * (frames - done);
  return seconds >= 60 ? `about ${Math.round(seconds / 60)} min left` : `about ${Math.max(1, Math.round(seconds))} s left`;
}

/** Title, text and behaviour of the export toast for each capture phase. */
function turntableToast(status: TurntableStatus | null, since: { at: number; done: number } | null) {
  switch (status?.phase) {
    case 'rendering': {
      const left = turntableTimeLeft(status.done, status.frames, since);
      return {
        title: `Exporting ${TURNTABLE_FORMATS[status.format].label}`,
        description: status.done === 0
          ? 'Preparing\u2026'
          : `${status.done} of ${status.frames} frames${left ? `, ${left}` : ''}`,
        progress: status.done === 0 ? 'indeterminate' as const : status.done / status.frames,
      };
    }
    case 'finishing':
      return { title: `Exporting ${TURNTABLE_FORMATS[status.format].label}`, description: 'Finishing file\u2026', progress: 1 };
    case 'saved':
      return {
        title: `${TURNTABLE_FORMATS[status.format].label} saved`,
        description: `${status.width} x ${status.height}, ${formatSize(status.bytes)}`,
        dismissible: true,
        timeout: 5_000,
      };
    case 'stopped':
      return { title: 'Export stopped', description: status.reason, dismissible: true, timeout: 6_000 };
    case 'failed':
      return { title: 'Export failed', description: status.message, tone: 'error' as const, dismissible: true };
    default:
      return { title: '', description: '' };
  }
}

interface UseTurntableCaptureOptions {
  turntableFormat: TurntableFormat;
  patch: (p: Partial<ControlsState>) => void;
  onSaveTurntable: (onStatus: (status: TurntableStatus) => void, signal?: AbortSignal) => Promise<void>;
  /** The first weapon has painted (or boot finished without one). */
  bootReady: boolean;
  // The rest only feed the abort-on-change effect below.
  selectedKitId: number | null;
  weaponKey: string;
  team: ControlsState['team'];
  wearIndex: number;
  seed: string;
  sheen: ControlsState['sheen'];
  unusual: ControlsState['unusual'];
  fov: number;
  projection: ControlsState['projection'];
  preset: string;
  selectedMaterialOverrideId: string;
  packageGeneration: number;
  editorDefinitionGeneration: number;
  activeTextureOverrides: Record<string, string>;
  viewAngleId: string;
  firstPersonActive: boolean;
  editingMode: string | null;
}

/** Animated capture: format support, progress toast, cancel/retry, and abort-on-change. */
export function useTurntableCapture({
  turntableFormat,
  patch,
  onSaveTurntable,
  bootReady,
  selectedKitId,
  weaponKey,
  team,
  wearIndex,
  seed,
  sheen,
  unusual,
  fov,
  projection,
  preset,
  selectedMaterialOverrideId,
  packageGeneration,
  editorDefinitionGeneration,
  activeTextureOverrides,
  viewAngleId,
  firstPersonActive,
  editingMode,
}: UseTurntableCaptureOptions) {
  const [turntableFormats, setTurntableFormats] = useState<TurntableFormat[]>(['gif', 'apng']);
  // Probed once: GIF and APNG always work, WebP/MP4 depend on this browser's
  // encoders. If the stored choice turns out unsupported, fall back to GIF.
  // Waits for boot: the canvas probe stalls on the GPU process while it
  // compiles the first shaders, which delayed the first paint.
  useEffect(() => {
    if (!bootReady) return;
    let cancelled = false;
    void supportedTurntableFormats().then((formats) => {
      if (cancelled) return;
      setTurntableFormats(formats);
      if (!formats.includes(turntableFormat)) patch({ turntableFormat: 'gif' });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady]);

  const [turntableStatus, setTurntableStatus] = useState<TurntableStatus | null>(null);
  const turntableCaptureControllerRef = useRef<AbortController | null>(null);
  // The first progress report after setup, for the remaining-time estimate
  // (setup time before the first frame would skew the per-frame rate).
  const turntableProgressStartRef = useRef<{ at: number; done: number } | null>(null);

  const startTurntableCapture = useCallback(async () => {
    const controller = new AbortController();
    turntableCaptureControllerRef.current = controller;
    try {
      await onSaveTurntable((status) => {
        if (status.phase !== 'rendering' || status.done === 0) turntableProgressStartRef.current = null;
        else turntableProgressStartRef.current ??= { at: performance.now(), done: status.done };
        setTurntableStatus(status);
      }, controller.signal);
    } finally {
      if (turntableCaptureControllerRef.current === controller) turntableCaptureControllerRef.current = null;
    }
  }, [onSaveTurntable]);

  // Rebuilt only when what the buttons do changes, so progress updates do not
  // hand the toast new action objects every frame.
  const turntableStopReason = turntableStatus?.phase === 'stopped' ? turntableStatus.reason : null;
  const turntableCaptureActions = useMemo(() => {
    if (turntableStatus?.phase === 'rendering' || turntableStatus?.phase === 'finishing') {
      return [{ label: 'Cancel', onClick: (): void => turntableCaptureControllerRef.current?.abort(TURNTABLE_CANCELLED) }];
    }
    // A capture the user cancelled needs no retry; one the scene interrupted
    // or that failed gets one.
    if (turntableStatus?.phase === 'failed' || (turntableStopReason && turntableStopReason !== TURNTABLE_CANCELLED)) {
      return [{ label: 'Try again', primary: true, onClick: (): void => void startTurntableCapture() }];
    }
    return undefined;
  }, [turntableStatus?.phase, turntableStopReason, startTurntableCapture]);

  // Abort a capture in flight if anything that would change what it renders
  // changes under it: the selected paint/kit, weapon, team, wear, seed, sheen,
  // unusual effect, fov, projection, lighting preset, material override, the
  // mounted source package or edited definitions, manual texture overrides,
  // the view angle, First Person, or entering/leaving an editing mode. Capture
  // settings (captureFormat, turntable* fields, screenshotMaxEdge), autoSpin,
  // and turntableStatus itself are deliberately excluded, since none of them
  // change what a capture in progress renders, and none of the effect's deps
  // change merely because a capture started.
  useEffect(() => {
    turntableCaptureControllerRef.current?.abort('The item or view changed during capture');
  }, [
    selectedKitId,
    weaponKey,
    team,
    wearIndex,
    seed,
    sheen,
    unusual,
    fov,
    projection,
    preset,
    selectedMaterialOverrideId,
    packageGeneration,
    editorDefinitionGeneration,
    activeTextureOverrides,
    viewAngleId,
    firstPersonActive,
    editingMode,
  ]);

  return {
    turntableFormats,
    startTurntableCapture,
    turntableToastProps: {
      open: turntableStatus !== null,
      ...turntableToast(turntableStatus, turntableProgressStartRef.current),
      actions: turntableCaptureActions,
    },
    closeTurntableToast: () => setTurntableStatus(null),
  };
}
