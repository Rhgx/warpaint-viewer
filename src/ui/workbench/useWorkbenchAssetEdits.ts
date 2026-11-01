import { useState, type Dispatch, type SetStateAction } from 'react';
import type { TextureMetadata } from '../../data/types';
import { texturePublicPath } from '../../protodefs/values';
import { mergeAlpha, loadImage, readTexture } from '../../workbench/textureImport';
import { revokeReleasedAssetUrls, revokeTextureUrl } from '../../workbench/assetUrls';
import type { WarpaintAssetOverrides, WarpaintAssetState } from '../../workbench/types';
import { referenceStem } from './workbenchLabels';
import type { WorkbenchEditor } from './workbenchTypes';

export function useWorkbenchAssetEdits({
  slots,
  textureMetadata,
  editor,
  onChange,
  onResetAll,
  setAssets,
  setErrors,
  setBusy,
  assetsRef,
  revisionRef,
}: {
  slots: readonly { ref: string }[];
  textureMetadata: Record<string, TextureMetadata> | undefined;
  editor: WorkbenchEditor | undefined;
  onChange: (overrides: WarpaintAssetOverrides) => void;
  onResetAll?: () => void;
  setAssets: Dispatch<SetStateAction<Record<string, WarpaintAssetState>>>;
  setErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setBusy: Dispatch<SetStateAction<Record<string, boolean>>>;
  assetsRef: { current: Record<string, WarpaintAssetState> };
  revisionRef: { current: number };
}) {
  const commit = (next: Record<string, WarpaintAssetState>) => {
    const previous = assetsRef.current;
    assetsRef.current = next;
    setAssets(next);
    revisionRef.current += 1;
    onChange({ revision: revisionRef.current, assets: next });
    revokeReleasedAssetUrls(previous, next);
  };

  const setSlotError = (ref: string, message: string) => {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[ref] = message;
      else delete next[ref];
      return next;
    });
  };

  const rebuild = async (
    asset: WarpaintAssetState,
  ): Promise<WarpaintAssetState> => {
    if (!asset.color) return { ...asset, output: undefined, size: undefined };
    const output = asset.alpha
      ? await mergeAlpha(asset.color.dataUrl, asset.alpha.dataUrl)
      : asset.color.dataUrl;
    try {
      const image = await loadImage(output);
      return {
        ...asset,
        output,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      };
    } catch (cause) {
      if (output !== asset.color.dataUrl) revokeTextureUrl(output);
      throw cause;
    }
  };

  const updateFile = async (
    ref: string,
    file: File | undefined,
    alphaOnly: boolean,
  ): Promise<string> => {
    if (!file) return '';
    setSlotError(ref, '');
    setBusy((current) => ({ ...current, [ref]: true }));
    let importedSource: string | undefined;
    let committed = false;
    try {
      const read = await readTexture(file, alphaOnly);
      importedSource = read.dataUrl;
      const current = assetsRef.current[ref] ?? {};
      const nextAsset: WarpaintAssetState = alphaOnly
        ? {
            ...current,
            alpha: { dataUrl: read.dataUrl, fileName: read.fileName },
          }
        : {
            ...current,
            color: read,
            alpha: read.hasEmbeddedAlpha ? undefined : current.alpha,
          };
      commit({ ...assetsRef.current, [ref]: await rebuild(nextAsset) });
      committed = true;
      return '';
    } catch (cause) {
      if (!committed) revokeTextureUrl(importedSource);
      const message = cause instanceof Error
        ? cause.message
        : 'The file could not be imported.';
      setSlotError(ref, message);
      return message;
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[ref];
        return next;
      });
    }
  };

  // Shared artwork gets a fresh reference so only the chosen use changes.
  // An image this editor already split off is replaced in place.
  const [editImportError, setEditImportError] = useState('');
  const isSplitOffReference = (ref: string) => Boolean(assetsRef.current[ref] && !textureMetadata?.[ref]);
  const freshReference = (stem: string) => {
    const taken = (candidate: string) => {
      const ref = texturePublicPath(candidate) ?? '';
      return Boolean(assetsRef.current[ref] || textureMetadata?.[ref] || slots.some((slot) => slot.ref === ref));
    };
    let candidate = stem;
    for (let n = 2; taken(candidate); n += 1) candidate = `${stem}_${n}`;
    return candidate;
  };
  const importEditTexture = async (
    reference: string,
    file: File,
    split: boolean,
    onSplit: (reference: string) => void,
  ) => {
    setEditImportError('');
    const target = split ? freshReference(referenceStem(reference)) : referenceStem(reference);
    const ref = texturePublicPath(target);
    if (!ref) return;
    const error = await updateFile(ref, file, false);
    if (error) setEditImportError(error);
    else if (split) onSplit(target);
  };

  const replaceStickerImage = (file: File) => {
    const sticker = editor?.sticker;
    const active = sticker?.targets.find((target) => target.id === sticker.activeTargetId);
    if (!sticker?.onSetTargetTexture || !active?.baseReference) return;
    const ref = texturePublicPath(referenceStem(active.baseReference)) ?? '';
    const split = (active.sharedWith ?? 0) > 0 || !isSplitOffReference(ref);
    void importEditTexture(active.baseReference, file, split, sticker.onSetTargetTexture);
  };
  const replaceVariantImage = (index: number, file: File) => {
    const sticker = editor?.sticker;
    const variants = sticker?.variants ?? [];
    const variant = variants.find((row) => row.index === index);
    if (!sticker?.onSetVariantBase || !variant?.baseReference) return;
    // Always split: another sticker or variant may draw the same texture.
    void importEditTexture(variant.baseReference, file, true, (reference) => sticker.onSetVariantBase?.(index, reference));
  };
  const replaceTeamTexture = (team: 'red' | 'blu', file: File) => {
    const colors = editor?.teamColors;
    const side = colors?.[team];
    if (!colors || !side) return;
    const other = colors[team === 'red' ? 'blu' : 'red'];
    const ref = texturePublicPath(referenceStem(side)) ?? '';
    const split = !isSplitOffReference(ref) || referenceStem(other ?? '') === referenceStem(side);
    void importEditTexture(
      split ? `${referenceStem(side)}_${team}` : side,
      file,
      split,
      (reference) => colors.onSetTexture(team, reference),
    );
  };

  const removeAlpha = async (ref: string) => {
    const current = assetsRef.current[ref];
    if (!current?.alpha) return;
    const { alpha: _alpha, ...rest } = current;
    commit({ ...assetsRef.current, [ref]: await rebuild(rest) });
  };

  const resetSlot = (ref: string) => {
    const next = { ...assetsRef.current };
    delete next[ref];
    setSlotError(ref, '');
    commit(next);
  };

  const resetAll = () => {
    setErrors({});
    commit({});
    onResetAll?.();
  };

  return {
    editImportError,
    updateFile,
    removeAlpha,
    resetSlot,
    resetAll,
    replaceStickerImage,
    replaceVariantImage,
    replaceTeamTexture,
  };
}
