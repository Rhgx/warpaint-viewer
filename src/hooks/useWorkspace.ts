import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { clearCustomWorkspace } from '../editor/draftStorage';
import type { useEditorDraft } from '../editor/useEditorDraft';
import type { PaintkitEntry } from '../data/types';
import type { WarpaintAssetOverrides, WorkbenchTab } from '../workbench/types';
import type { useCustomDefinitions } from './useCustomDefinitions';
import type { useSourcePackage } from './useSourcePackage';

interface UseWorkspaceOptions {
  definitions: ReturnType<typeof useCustomDefinitions>;
  sourcePackage: ReturnType<typeof useSourcePackage>['sourcePackage'];
  packageGeneration: number;
  editorDraft: Pick<ReturnType<typeof useEditorDraft>, 'status'>;
  editorDirty: boolean;
  selectedKit: PaintkitEntry | null;
  assetOverrideCache: Record<string, WarpaintAssetOverrides>;
  removePackage: () => void;
  clearAssetOverrideCache: () => void;
  setWorkbenchExpanded: (expanded: boolean) => void;
  setWorkbenchTab: Dispatch<SetStateAction<WorkbenchTab>>;
}

/** Imported-file workspace: the clear dialog, the unload guard, and the definitions prompt. */
export function useWorkspace({
  definitions,
  sourcePackage,
  packageGeneration,
  editorDraft,
  editorDirty,
  selectedKit,
  assetOverrideCache,
  removePackage,
  clearAssetOverrideCache,
  setWorkbenchExpanded,
  setWorkbenchTab,
}: UseWorkspaceOptions) {
  const [clearWorkspaceOpen, setClearWorkspaceOpen] = useState(false);
  const [clearingWorkspace, setClearingWorkspace] = useState(false);
  const [clearWorkspaceError, setClearWorkspaceError] = useState<string | null>(null);
  const [workspaceCleared, setWorkspaceCleared] = useState<{ drafts: number } | null>(null);

  const packageMounted = sourcePackage.status === 'mounted';
  const definitionsLoaded = definitions.state.status === 'loaded';
  const hasWorkspace = packageMounted || definitionsLoaded;

  const openClearWorkspace = useCallback(() => {
    setClearWorkspaceError(null);
    setClearWorkspaceOpen(true);
  }, []);

  const clearWorkspaceWarning = editorDraft.status === 'error'
    ? 'Your editor draft could not be saved locally, so it will not come back after this.'
    : editorDirty
      ? `You have unsaved edits${selectedKit?.name ? ` to ${selectedKit.name}` : ''}. They are part of what gets removed.`
      : null;

  const clearWorkspace = useCallback(() => {
    setClearingWorkspace(true);
    setClearWorkspaceError(null);
    void clearCustomWorkspace().then((result) => {
      removePackage();
      definitions.state.onRemove();
      clearAssetOverrideCache();
      setWorkbenchExpanded(false);
      setWorkbenchTab('files');
      setClearWorkspaceOpen(false);
      setWorkspaceCleared({ drafts: result.drafts });
    }).catch((cause) => {
      setClearWorkspaceError(cause instanceof Error
        ? cause.message
        : 'The local data could not be deleted.');
    }).finally(() => setClearingWorkspace(false));
  }, [clearAssetOverrideCache, definitions.state, removePackage, setWorkbenchExpanded, setWorkbenchTab]);

  // Custom files only live in memory. Let the browser warn before a refresh,
  // tab close, or navigation would discard any cached edit set.
  useEffect(() => {
    const hasCachedEdits = Object.values(assetOverrideCache).some((entry) => Object.keys(entry.assets).length > 0);
    const editorDraftAtRisk = editorDirty && editorDraft.status !== 'saved';
    if (!hasCachedEdits && !editorDraftAtRisk && sourcePackage.status !== 'mounted' && definitions.state.status !== 'loaded') return;
    const confirmLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLoss);
    return () => window.removeEventListener('beforeunload', confirmLoss);
  }, [assetOverrideCache, editorDirty, editorDraft.status, sourcePackage.status, definitions.state.status]);

  // A mounted package often carries the definitions its textures belong to, but
  // the Definitions tab that says so is behind a drawer most people never open.
  // Ask over the stage instead, once per package: importing or dismissing
  // answers it, and so does importing definitions from anywhere else.
  const { packageCandidate } = definitions.state;
  const candidateKey = packageCandidate ? `${packageGeneration}:${packageCandidate.path}` : '';
  const candidateKeyRef = useRef(candidateKey);
  candidateKeyRef.current = candidateKey;
  const [answeredCandidateKey, setAnsweredCandidateKey] = useState('');
  useEffect(() => {
    if (definitions.generation > 0) setAnsweredCandidateKey(candidateKeyRef.current);
  }, [definitions.generation]);
  const promptedCandidate = packageCandidate
    && candidateKey !== answeredCandidateKey
    && definitions.state.status !== 'importing'
    ? packageCandidate
    : null;

  return {
    clearWorkspaceOpen,
    setClearWorkspaceOpen,
    clearingWorkspace,
    clearWorkspaceError,
    workspaceCleared,
    setWorkspaceCleared,
    hasWorkspace,
    openClearWorkspace,
    clearWorkspaceWarning,
    clearWorkspace,
    candidateKey,
    setAnsweredCandidateKey,
    promptedCandidate,
  };
}
