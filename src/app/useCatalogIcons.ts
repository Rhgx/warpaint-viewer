import { useMemo } from 'react';
import type { PaintkitEntry } from '../data/types';
import type { useBootData } from '../hooks/useBootData';
import type { useCustomDefinitions } from '../hooks/useCustomDefinitions';
import type { useCustomWarpaintIcons } from '../hooks/useCustomWarpaintIcons';

interface UseCatalogIconsOptions {
  data: ReturnType<typeof useBootData>['data'];
  selectedKitWeapons: PaintkitEntry['weapons'] | undefined;
  definitionIcons: ReturnType<typeof useCustomDefinitions>['icons'];
  renderedCustomIcons: ReturnType<typeof useCustomWarpaintIcons>;
}

export function useCatalogIcons({
  data,
  selectedKitWeapons,
  definitionIcons,
  renderedCustomIcons,
}: UseCatalogIconsOptions) {
  const weaponOptions = useMemo(() => {
    if (!data) return [];
    return (selectedKitWeapons ?? data.manifest.weapons.map((w) => w.key)).map((key) => {
      const weapon = data.manifest.weapons.find((w) => w.key === key);
      return {
        value: key,
        label: weapon?.name ?? key,
        icon: weapon?.icon ? data.getAssetUrl(weapon.icon) : null,
      };
    });
  }, [data, selectedKitWeapons]);

  const collectionIcons = useMemo(() => {
    const icons: Record<string, string> = {};
    for (const [name, rel] of Object.entries(data?.manifest.collectionIcons ?? {})) {
      const url = data?.getAssetUrl(rel);
      if (url) icons[name] = url;
    }
    return icons;
  }, [data]);

  // Imported kits have no shipped thumbnail; theirs is resolved from the
  // pattern texture the definition names, through the mounted package.
  const paintIcons = useMemo(() => {
    const icons: Record<number, string> = { ...definitionIcons, ...renderedCustomIcons };
    for (const kit of data?.manifest.paintkits ?? []) {
      const url = kit.icon ? data?.getAssetUrl(kit.icon) : null;
      if (url) icons[kit.id] = url;
    }
    return icons;
  }, [data, definitionIcons, renderedCustomIcons]);

  return { weaponOptions, collectionIcons, paintIcons };
}
