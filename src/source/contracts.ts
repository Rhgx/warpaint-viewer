/** A file in a mounted Source-style archive, keyed by canonical Source path. */
export interface SourceEntry {
  /** Lowercase, slash-separated path relative to the Source game root. */
  path: string;
  /** Uncompressed byte length. */
  size: number;
  /** Compressed byte length when the container exposes it. */
  compressedSize?: number;
  /** Unsigned CRC-32 from the container directory, when available. */
  crc32?: number;
}

export type SourcePackageFormat = 'zip' | 'vpk';

/**
 * A lazily readable, mounted Source archive. Consumers always address entries
 * using canonical Source paths, irrespective of the backing archive format.
 */
export interface SourcePackage {
  readonly id: string;
  readonly name: string;
  readonly format: SourcePackageFormat;
  readonly entries: ReadonlyMap<string, SourceEntry>;

  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  dispose(): void;
}

export type SourceDiagnosticLevel = 'error' | 'warning' | 'info';

/** Suitable for direct display by the package-import UI. */
export interface SourceDiagnostic {
  id: string;
  level: SourceDiagnosticLevel;
  message: string;
  /** The archive name or entry path associated with this message, if singular. */
  detail?: string;
}

/** Machine-readable failure for validation and lazy reads. */
export class SourcePackageError extends Error {
  readonly name = 'SourcePackageError';
  readonly code: string;
  readonly path: string | undefined;
  readonly cause: unknown;

  constructor(
    code: string,
    message: string,
    path?: string,
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.path = path;
    this.cause = cause;
  }
}

/** A successful package open can still carry non-fatal import diagnostics. */
export interface SourcePackageOpenResult {
  package: SourcePackage;
  diagnostics: SourceDiagnostic[];
  /** War paint index inferred from a numeric package wrapper directory. */
  suggestedPaintkitId?: number;
}
