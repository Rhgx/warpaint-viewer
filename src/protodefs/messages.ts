export type Many<T> = T | T[] | undefined;

export function many<T>(value: Many<T>): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface VarDefMsg {
  name: string;
  value?: string;
  inherit?: boolean;
}

export interface VarFieldMsg {
  variable?: string;
  float?: number;
  double?: number;
  uint32?: number;
  uint64?: number;
  sint32?: number;
  sint64?: number;
  bool?: boolean;
  string?: string;
}

export interface HeaderMsg {
  defindex: number;
  name?: string;
  variables?: Many<VarDefMsg>;
}

export interface DefIdMsg {
  defindex: number;
  type?: number;
}

export interface ItemDataMsg {
  can_apply_paintkit?: boolean;
  material_override?: string;
  variable?: Many<VarFieldMsg>;
}

export interface ItemMsg {
  item_definition_template: DefIdMsg;
  data?: ItemDataMsg;
}

export interface DefinitionEntryMsg {
  operation_template?: DefIdMsg;
  variable?: Many<VarFieldMsg>;
}

export interface ItemDefinitionMsg {
  header: HeaderMsg;
  item_definition_index: number;
  variable_template?: DefIdMsg;
  definition?: Many<DefinitionEntryMsg>;
}

export interface TextureStageMsg {
  texture?: VarFieldMsg;
  texture_red?: VarFieldMsg;
  texture_blue?: VarFieldMsg;
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  rotation?: VarFieldMsg;
  translate_u?: VarFieldMsg;
  translate_v?: VarFieldMsg;
  scale_uv?: VarFieldMsg;
  flip_u?: VarFieldMsg;
  flip_v?: VarFieldMsg;
}

export interface CombineStageMsg {
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  rotation?: VarFieldMsg;
  translate_u?: VarFieldMsg;
  translate_v?: VarFieldMsg;
  scale_uv?: VarFieldMsg;
  flip_u?: VarFieldMsg;
  flip_v?: VarFieldMsg;
  operation_node?: Many<OperationNodeMsg>;
}

export interface SelectStageMsg {
  groups?: VarFieldMsg;
  select?: Many<VarFieldMsg>;
}

export interface StickerMsg {
  base?: VarFieldMsg;
  weight?: VarFieldMsg;
  spec?: VarFieldMsg;
}

export interface StickerStageMsg {
  sticker?: Many<StickerMsg>;
  dest_tl?: VarFieldMsg;
  dest_tr?: VarFieldMsg;
  dest_bl?: VarFieldMsg;
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  operation_node?: Many<OperationNodeMsg>;
}

export interface OperationStageMsg {
  texture_lookup?: TextureStageMsg;
  combine_add?: CombineStageMsg;
  combine_lerp?: CombineStageMsg;
  combine_multiply?: CombineStageMsg;
  select?: SelectStageMsg;
  apply_sticker?: StickerStageMsg;
}

export interface OperationNodeMsg {
  stage?: OperationStageMsg;
  operation_template?: DefIdMsg;
}

export interface OperationMsg {
  header: HeaderMsg;
  operation_node?: Many<OperationNodeMsg>;
}

export interface PaintkitDefinitionMsg {
  header: HeaderMsg;
  loc_desctoken?: string;
  operation_template?: DefIdMsg;
  has_team_textures?: boolean;
  item?: Many<ItemMsg>;
  [slotName: string]: unknown;
}

export function asItem(value: unknown): ItemMsg | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ItemMsg>;
  return candidate.item_definition_template ? (candidate as ItemMsg) : undefined;
}
