/**
 * Builds the definition half of a pack: the files that make a war paint exist
 * in someone's game, as opposed to the textures that make it look like itself.
 *
 * A paint the viewer imported lives only in memory. For the game to show it,
 * three things have to land in tf/custom/:
 *   scripts/protodefs/proto_defs.vpd          the paint's definition + operation
 *   resource/tf_proto_obj_defs_<lang>.txt     its display name
 *   materials/...                             its textures, handled elsewhere
 *
 * Both of the first two SHADOW the game's own copies rather than merging with
 * them, so each is written as a complete file built from a full base: the
 * snapshot this site ships, or the player's own copy when they supply one.
 */

import type { ProtoDefKitMessages } from '../protodefs/types';
import {
  decodeLocalization,
  encodeLocalization,
  localizationPackPath,
  setPaintkitName,
} from './localization';
import { spliceProtoDefs } from './protoWrite';
import type { SpliceMode } from './protoWrite';
import type { ExportExtraFile } from './bundle';

/** Where the game reads a mod's definitions from. */
export const PACK_PROTO_DEFS_PATH = 'scripts/protodefs/proto_defs.vpd';

export interface DefinitionsBuildOptions {
  /** A complete proto_defs container to splice into. */
  baseContainer: Uint8Array;
  /** The imported paint's two messages, from ProtoDefSource.exportKit(). */
  kit: ProtoDefKitMessages;
  mode: SpliceMode;
  /** Paint kit to replace, when mode is 'overwrite'. */
  targetDefindex?: number;
  /** Display name to register. Skipped entirely when blank. */
  name?: string;
  /**
   * Complete localization files to name the paint in, keyed by language. Each
   * is the whole shipped file; one token is added or replaced in each.
   */
  localization?: ReadonlyMap<string, Uint8Array>;
}

export interface DefinitionsBuildResult {
  files: ExportExtraFile[];
  paintkitDefindex: number;
  operationDefindex: number;
  replaced: boolean;
  /** Languages the name was written into. */
  languages: string[];
  warnings: string[];
}

export function buildDefinitionFiles(options: DefinitionsBuildOptions): DefinitionsBuildResult {
  const spliced = spliceProtoDefs({
    baseBytes: options.baseContainer,
    operation: options.kit.operation,
    definition: options.kit.definition,
    mode: options.mode,
    targetDefindex: options.targetDefindex,
  });

  const files: ExportExtraFile[] = [{ path: PACK_PROTO_DEFS_PATH, data: spliced.bytes }];
  const warnings: string[] = [];
  const languages: string[] = [];

  const name = options.name?.trim();
  if (name && options.localization) {
    for (const [language, bytes] of options.localization) {
      try {
        const named = setPaintkitName(decodeLocalization(bytes), spliced.paintkitDefindex, name);
        files.push({ path: localizationPackPath(language), data: encodeLocalization(named) });
        languages.push(language);
      } catch (cause) {
        warnings.push(
          `The ${language} name could not be written: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        );
      }
    }
  } else if (!name) {
    warnings.push(
      spliced.replaced
        ? 'No name was given, so this paint keeps the name of the kit it replaces.'
        : `No name was given, so the game will show this paint as its raw token (#9_${spliced.paintkitDefindex}).`,
    );
  }

  if (!spliced.replaced) {
    warnings.push(
      'This paint was added under a new definition index, so nothing in the game owns it yet. '
      + 'Equipping it needs a server plugin (https://github.com/Mince1844/tf2warpaints); '
      + 'to preview it on an item you already have, overwrite an existing war paint instead.',
    );
  }

  return {
    files,
    paintkitDefindex: spliced.paintkitDefindex,
    operationDefindex: spliced.operationDefindex,
    replaced: spliced.replaced,
    languages,
    warnings,
  };
}
