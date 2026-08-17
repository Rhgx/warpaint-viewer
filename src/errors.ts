import type { SourceDiagnostic, SourceDiagnosticLocation } from './source/contracts';

/** Public error-code registry. Values are stable; property names may be refactored. */
export const ERROR_CODES = {
  definitionImportFailed: 'WV-DEF-1000',
  definitionJsonUnterminatedString: 'WV-DEF-1001',
  definitionJsonSyntax: 'WV-DEF-1002',
  definitionJsonNotObject: 'WV-DEF-1003',
  definitionJsonTooLarge: 'WV-DEF-1004',
  definitionUnknownFragment: 'WV-DEF-1005',
  definitionJsonIncomplete: 'WV-DEF-1006',
  packageImportFailed: 'WV-PKG-1000',
  packageMixedFormats: 'WV-PKG-1001',
  packageZipSelection: 'WV-PKG-1002',
  packageUnsupportedSelection: 'WV-PKG-1003',
} as const;

export type AppErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

interface AppErrorOptions {
  technicalDetail?: string;
  path?: string;
  location?: SourceDiagnosticLocation;
  cause?: unknown;
}

/**
 * An application failure with separate public and developer-facing messages.
 *
 * UI boundaries should convert this with appErrorDiagnostic() instead of
 * displaying Error.message directly. See docs/error-codes.md for the public
 * code contract and rules for allocating new codes.
 */
export class AppError extends Error {
  readonly name: string = 'AppError';
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly technicalDetail: string | undefined;
  readonly path: string | undefined;
  readonly location: SourceDiagnosticLocation | undefined;
  override readonly cause: unknown;

  constructor(code: AppErrorCode, userMessage: string, options: AppErrorOptions = {}) {
    super(options.technicalDetail ?? userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.technicalDetail = options.technicalDetail;
    this.path = options.path;
    this.location = options.location;
    this.cause = options.cause;
  }
}

export function appErrorDiagnostic(
  cause: unknown,
  fallback: { code: AppErrorCode; message: string; idPrefix: string },
): SourceDiagnostic {
  if (cause instanceof AppError) {
    return {
      id: `${fallback.idPrefix}:${cause.code}:${Date.now()}`,
      level: 'error',
      message: cause.userMessage,
      code: cause.code,
      detail: cause.path,
      location: cause.location,
      technicalDetail: cause.technicalDetail ?? cause.stack ?? cause.message,
    };
  }
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const path = 'path' in error && typeof error.path === 'string' ? error.path : undefined;
  const internalCode = 'code' in error && typeof error.code === 'string'
    ? `Internal code: ${error.code}\n`
    : '';
  return {
    id: `${fallback.idPrefix}:${fallback.code}:${Date.now()}`,
    level: 'error',
    message: fallback.message,
    code: fallback.code,
    detail: path,
    technicalDetail: `${internalCode}${error.stack ?? error.message}`,
  };
}
