import { useState } from 'react';
import type { ExportCompression } from '../export/plan';
import type { WarpaintExportInputs } from '../workbench/exportTypes';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useWarpaintExport(inputs: WarpaintExportInputs) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [buildNotes, setBuildNotes] = useState<string[]>([]);

  const runExport = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const extras: { path: string; data: Uint8Array }[] = [];
      const notes: string[] = [];
      const { definitions } = inputs;

      if (definitions && definitions.packageFileCount > 0) {
        extras.push(...(await definitions.packageFiles()));
      }

      if (inputs.writesDefinitions && definitions) {
        if (inputs.definitionsMode === 'overwrite' && !inputs.targetDefindex) {
          throw new Error(
            'Choose which war paint this should replace, or add it as a new one instead.',
          );
        }
        const kit = await definitions.loadKitMessages();
        if (!kit)
          throw new Error(
            'This war paint’s definitions could not be read. Re-import them and try again.',
          );
        const [
          { buildDefinitionFiles },
          { loadSnapshotContainer, loadSnapshotLocalizations },
        ] = await Promise.all([
          import('../export/definitions'),
          import('../export/snapshot'),
        ]);
        const [baseContainer, localization] = await Promise.all([
          loadSnapshotContainer(),
          inputs.inGameName.trim()
            ? loadSnapshotLocalizations()
            : Promise.resolve(new Map<string, Uint8Array>()),
        ]);
        const { collectMaterialOverrides } = await import('../export/plan');
        const overrides = collectMaterialOverrides(kit.definition);
        if (overrides.length) {
          const materials = await definitions.materialFiles(overrides);
          extras.push(...materials.files);
          if (materials.repaired.length) {
            notes.push(
              `${materials.repaired.length} material${materials.repaired.length === 1 ? '' : 's'} the definition names ` +
                `(${materials.repaired[0]}) only existed in the package under the other "c_" spelling, so the pack carries ` +
                'a copy under the name the definition asks for.',
            );
          }
          if (materials.missing.length) {
            notes.push(
              `${materials.missing.length} of the ${overrides.length} materials this paint names are not in the mounted package ` +
                `(for example ${materials.missing[0]}). Without them the game has nothing to draw the paint with.`,
            );
          }
        }

        const built = buildDefinitionFiles({
          baseContainer,
          kit,
          mode:
            inputs.definitionsMode === 'append' ? 'append' : 'overwrite',
          targetDefindex:
            inputs.definitionsMode === 'overwrite'
              ? Number(inputs.targetDefindex)
              : undefined,
          name: inputs.inGameName,
          localization,
        });
        extras.push(...built.files);
        notes.push(...built.warnings);
      }

      const { buildWarpaintExport } = await import('../export/bundle');
      const result = await buildWarpaintExport(
        inputs.items.map((item) => ({
          ref: item.ref,
          source: item.output,
          kind: item.kind,
          metadata: inputs.textureMetadata?.[item.ref],
        })),
        {
          packName: inputs.packName,
          container: inputs.container as 'zip' | 'vpk',
          compression: inputs.compression as ExportCompression,
          paintName: inputs.paintName,
          weaponName: inputs.weaponName,
          gameBuild: inputs.gameBuild,
          snapshotDate: inputs.snapshotDate,
          requiresDefinitionBypass: inputs.writesDefinitions,
        },
        extras,
      );
      setBuildNotes(notes);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDone(`${result.fileName} (${formatSize(result.blob.size)})`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The export could not be built.',
      );
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, done, buildNotes, runExport };
}
