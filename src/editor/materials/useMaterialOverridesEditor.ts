import { useMemo, useState } from 'react';
import type { DataSource } from '../../data/loader';
import { packageHasMaterialOverride, type indexPackageMaterialPaths } from '../../source/vmt';
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
  mountedMaterialPaths: ReturnType<typeof indexPackageMaterialPaths> | null;
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

  // Some weapons are painted by kits that use material overrides, yet no stock
  // kit ever gives them one. Bazaar Bargain is the case the community reports
  // rendering oddly with Macaw materials, and the shipped data agrees: of the
  // 37 override-using kits that paint it, none override its material. Deriving
  // the rule from the data rather than naming weapons keeps it correct if a
  // future game update starts overriding one of them.
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
    // A single kit skipping a weapon says nothing; a weapon skipped by every
    // override-using kit that paints it is a deliberate authoring convention.
    for (const [key, count] of painted) {
      if (count >= 5 && !overridden.has(key)) excluded.add(key);
    }
    return excluded;
  }, [data?.manifest.paintkits]);

  // Real per-weapon material_override rows for the Materials sub-view, driven
  // by the kit's actual resolved weapon slots (named fields and repeated
  // `item` entries alike; see materialTargets.ts and weaponSlots in useEditorCore).
  const weaponMaterialTargets = editorCurrent && weaponSlots.length > 0
    ? discoverWeaponMaterialTargets(editorCurrent, weaponSlots)
    : [];
  const materialWeaponRows: MaterialWeaponRow[] = weaponMaterialTargets.map((entry) => {
    const enabled = entry.overridePath !== null;
    // Only an actually mounted archive can prove a material absent. With none
    // mounted the honest answer is "unknown", so the row stays unflagged
    // rather than accusing every weapon of a missing file.
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
        // Exclusion stays manual, per the feature request: a flagged weapon is
        // never switched on by the preset, but the row is still there to tick
        // by hand for anyone who wants it anyway.
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
