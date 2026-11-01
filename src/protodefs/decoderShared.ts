// Types and slot-path helpers shared by the protodef decoder modules.
import { asItem, many, type ItemDefinitionMsg, type ItemMsg, type Many, type PaintkitDefinitionMsg } from './messages';
import type { ResolveCtx } from './resolve';
import type { ProtoDefIndex } from './types';

// Named weapon slot fields on CMsgPaintKit_Definition; repeated `item` entries are separate.
export const WEAPON_SLOTS = [
  'paintkit_tool', 'flamethrower', 'grenadelauncher', 'knife', 'medigun', 'minigun', 'pistol', 'revolver',
  'rocketlauncher', 'scattergun', 'shotgun', 'smg', 'sniperrifle', 'stickybomb_launcher',
  'ubersaw', 'wrench', 'amputator', 'atom_launcher', 'back_scratcher', 'battleaxe',
  'bazaar_sniper', 'blackbox', 'claidheamohmor', 'crusaders_crossbow', 'degreaser',
  'demo_cannon', 'demo_sultan_sword', 'detonator', 'gatling_gun', 'holymackerel', 'jag',
  'lochnload', 'powerjack', 'quadball', 'reserve_shooter', 'riding_crop', 'russian_riot',
  'scimitar', 'scorch_shot', 'shortstop', 'soda_popper', 'tele_shotgun', 'tomislav',
  'trenchgun', 'winger_pistol',
];

// One weapon slot on a paintkit definition, resolved to the weapon it paints.
export interface ResolvedSlot {
  item: ItemMsg;
  itemDef: ItemDefinitionMsg;
  weaponKey: string;
}

export function manyEntryPath<T>(root: string[], source: Many<T>, index: number): string[] {
  return Array.isArray(source) ? [...root, String(index)] : root;
}

// A weapon slot's item message: a named WEAPON_SLOTS field, or an index into the repeated
// `item` array. Shared by provenance and the slot list, so both report the same path.
export function slotSourcePath(paintkitDef: PaintkitDefinitionMsg, slotItem: ItemMsg): string[] {
  for (const name of WEAPON_SLOTS) {
    if (asItem(paintkitDef[name]) === slotItem) return ['definition', name];
  }
  const items = many(paintkitDef.item);
  const index = items.indexOf(slotItem);
  return index >= 0 ? manyEntryPath(['definition', 'item'], paintkitDef.item, index) : ['weaponSlot'];
}

export interface DecodedContainer {
  kitsByDefindex: Map<number, { def: PaintkitDefinitionMsg; slots: ResolvedSlot[] }>;
  ctx: ResolveCtx;
  index: ProtoDefIndex;
}
