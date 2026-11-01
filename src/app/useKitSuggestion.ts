import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PaintkitEntry } from '../data/types';
import type { ControlsState } from '../viewer/controls';

interface UseKitSuggestionOptions {
  definitionsSuggestedKitId: number | undefined;
  definitionsGeneration: number;
  suggestedPaintkitId: number | undefined;
  packageGeneration: number;
  editorDirty: boolean;
  firstPersonActive: boolean;
  paintkits: PaintkitEntry[];
  setSelectedKitId: Dispatch<SetStateAction<number | null>>;
  setState: Dispatch<SetStateAction<ControlsState>>;
}

export function useKitSuggestion({
  definitionsSuggestedKitId,
  definitionsGeneration,
  suggestedPaintkitId,
  packageGeneration,
  editorDirty,
  firstPersonActive,
  paintkits,
  setSelectedKitId,
  setState,
}: UseKitSuggestionOptions): void {
  // An import can name the kit it is for. Switch only when that id resolves to a catalog entry.
  const suggestedKitId = definitionsSuggestedKitId ?? suggestedPaintkitId;
  // A later import re-applies its suggestion; a re-rendered catalog does not.
  const suggestionToken = definitionsSuggestedKitId !== undefined
    ? `defs:${definitionsGeneration}:${definitionsSuggestedKitId}`
    : `pkg:${packageGeneration}:${suggestedPaintkitId}`;
  // Keep every applied token. When a later suggestion clears, an earlier one
  // must not select its paint a second time.
  const appliedSuggestionsRef = useRef(new Set<string>());
  useEffect(() => {
    if (suggestedKitId === undefined || appliedSuggestionsRef.current.has(suggestionToken) || editorDirty) return;
    const kit = paintkits.find((entry) => entry.id === suggestedKitId);
    if (!kit) return;
    appliedSuggestionsRef.current.add(suggestionToken);
    setSelectedKitId(kit.id);
    setState((current) => ({
      ...current,
      weaponKey: kit.weapons.includes(current.weaponKey) ? current.weaponKey : (kit.weapons[0] ?? current.weaponKey),
      team: kit.hasTeamTextures || current.sheen === 'team_shine' || firstPersonActive ? current.team : 'red',
    }));
  }, [editorDirty, firstPersonActive, paintkits, suggestedKitId, suggestionToken, setSelectedKitId, setState]);
}
