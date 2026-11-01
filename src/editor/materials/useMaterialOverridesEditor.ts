import { useMemo, useState } from 'react';
import type { DataSource } from '../../data/loader';
import { packageHasMaterialOverride, type PackageMaterialPathIndex } from '../../source/vmt';
import type { MaterialOverridesPanelProps, MaterialWeaponRow } from '../../ui/editor/MaterialOverridesPanel';
import { discoverWeaponMaterialTargets, materialPresetPath } from './materialTargets';
import type { EditorCore } from '../useEditorCore';

interface UseMaterialOverridesEditorOptions extends
  Pick<EditorCore,
    | 'editorStatus'
    | 'editorCurrent'
    | 'weaponSlots'
    | 'setSessionWeaponMaterial'
    | 'setSessionWeaponMaterials'
  > {
  data: DataSource | null;
  mountedMaterialPaths: PackageMaterialPathIndex | null;
}

/** Per-weapon material overrides for the Materials mode; undefined until the paint names any weapon slot. */
export function useMaterialOverridesEditor({
  editorStatus,
  editorCurrent,
  weaponSlots,
  setSessionWeaponMaterial,
  setSessionWeaponMaterials,
  data,
  mountedMaterialPaths,
}: UseMaterialOverridesEditorOptions): MaterialOverridesPanelProps | undefined {
  const [materialPresetId, setMaterialPresetId] = useState('macaw-metallic');

  // Some weapons are painted by override-using kits that never override them (Bazaar Bargain, for one).
  // Deriving this from the data keeps it correct if a game update starts overriding one.
  const materialExcludedWeapons = useMemo(() => {
    const painted = new Map<string, number>();
    const overridden = new Set<string>();
    for (const kit of data?.manifest.paintkits ?? []) {
      const overrides = kit.materialOverrides;
      if (!overrides || Object.keys(overrides).length === 0) continue;
      for (const key of kit.weapons) painted.set(key, (painted.get(key) ?? 0) + 1);
      for (const key of Object.keys(overrides)) overridden.add(key);
    }
    const excluded = new Set<string>();
    // One kit skipping a weapon says nothing; a weapon skipped by five or more override-using kits is a convention.
    for (const [key, count] of painted) {
      if (count >= 5 && !overridden.has(key)) excluded.add(key);
    }
    return excluded;
  }, [data?.manifest.paintkits]);

  // Rows come from the kit's resolved weapon slots, named fields and repeated items alike.
  const weaponMaterialTargets = editorCurrent && weaponSlots.length > 0
    ? discoverWeaponMaterialTargets(editorCurrent, weaponSlots)
    : [];
  const materialWeaponRows: MaterialWeaponRow[] = weaponMaterialTargets.map((entry) => {
    const enabled = entry.overridePath !== null;
    // Only a mounted archive can prove a material missing; with none mounted, leave the row unflagged.
    const missing = entry.overridePath !== null && mountedMaterialPaths
      ? !packageHasMaterialOverride(mountedMaterialPaths, entry.overridePath)
      : undefined;
    const weapon = data?.manifest.weapons.find((w) => w.key === entry.weaponKey);
    return {
      key: entry.weaponKey,
      name: weapon?.name ?? entry.weaponKey,
      thumbnail: weapon?.icon ? data?.getAssetUrl(weapon.icon) ?? null : null,
      overridePath: entry.overridePath,
      enabled,
      missing,
      warning: materialExcludedWeapons.has(entry.weaponKey)
        ? 'No stock paint overrides this weapon'
        : undefined,
    };
  });
  const materialPresets = [{ id: 'macaw-metallic', label: 'Macaw metallic' }];
  return materialWeaponRows.length > 0 ? {
    weapons: materialWeaponRows,
    presets: materialPresets,
    activePresetId: materialPresetId,
    disabled: editorStatus !== 'ready',
    onActivePresetChange: setMaterialPresetId,
    onToggleWeapon: (key, enabled) => {
      const target = weaponMaterialTargets.find((entry) => entry.weaponKey === key)?.target;
      if (!target) return;
      setSessionWeaponMaterial(target, enabled ? materialPresetPath(materialPresetId, key) : null);
    },
    onSetWeapons: (keys, enabled) => {
      const selected = new Set(keys);
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => (
        selected.has(entry.weaponKey)
          ? [{
            target: entry.target,
            overridePath: enabled ? materialPresetPath(materialPresetId, entry.weaponKey) : null,
          }]
          : []
      )));
    },
    onApplyPreset: () => {
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => {
        // Flagged weapons stay out of the preset but can still be ticked by hand.
        const row = materialWeaponRows.find((candidate) => candidate.key === entry.weaponKey);
        return row?.warning ? [] : [{
          target: entry.target,
          overridePath: materialPresetPath(materialPresetId, entry.weaponKey),
        }];
      }));
    },
    onClearAll: () => {
      setSessionWeaponMaterials(weaponMaterialTargets.flatMap((entry) => (
        entry.overridePath === null ? [] : [{ target: entry.target, overridePath: null }]
      )));
    },
  } : undefined;
}
