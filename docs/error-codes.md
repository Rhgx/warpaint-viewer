# Error codes

Warpaint Viewer errors have three layers:

1. `message` or `userMessage` explains the failure in plain language.
2. `code` is a stable shorthand for bug reports, support, and tests.
3. `technicalDetail` contains parser output, stack traces, and internal context.

Parser failures may also include a one-based line and column. Technical details
are collapsed by default. Never include secrets or full user files.

## Code format

Public codes use `WV-AREA-NNNN`:

- `WV` identifies Warpaint Viewer.
- `AREA` identifies the subsystem, such as `DEF` for definitions or `PKG` for
  Source packages.
- `NNNN` is a permanent number within that subsystem.

Codes identify failure categories, not message wording. Never rename or reuse a
released code. Add codes to `ERROR_CODES` in `src/errors.ts`.

This is an app convention. An HTTP API can expose the code as an extension to
[RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457).

## Application API

Throw `AppError` for an understood failure:

```ts
throw new AppError(
  ERROR_CODES.definitionJsonSyntax,
  'This file contains invalid JSON.',
  {
    technicalDetail: parserError.message,
    path: 'paint_DEF.json',
    location: { line: 42, column: 17 },
    cause: parserError,
  },
);
```

Convert caught values at a UI boundary:

```ts
const diagnostic = appErrorDiagnostic(cause, {
  code: ERROR_CODES.definitionImportFailed,
  message: 'The definitions could not be imported.',
  idPrefix: 'defs:import',
});
```

Known errors keep their data. Unknown errors receive the fallback code and
message, with internal context placed in `technicalDetail`.

The UI receives this shape:

```ts
interface SourceDiagnostic {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  detail?: string;
  location?: { line: number; column: number };
  technicalDetail?: string;
}
```

Render panel diagnostics with `DiagnosticsList` from
`src/ui/workbench/DiagnosticItem.tsx`. It filters informational entries,
announces new problems, and scrolls the newest one into view. Panels only
control placement.

## Registered codes

| Code | Meaning |
| --- | --- |
| `WV-DEF-1000` | An unclassified definition import failure |
| `WV-DEF-1001` | A JSON string was not closed |
| `WV-DEF-1002` | Other invalid definition JSON syntax |
| `WV-DEF-1003` | Definition JSON is not one object |
| `WV-DEF-1004` | Definition JSON exceeds the size limit |
| `WV-DEF-1005` | JSON is not a recognized operation or definition fragment |
| `WV-DEF-1006` | Definition JSON ends before its structure is complete |
| `WV-PKG-1000` | An unclassified ZIP or VPK package import failure |
| `WV-PKG-1001` | ZIP and VPK files were selected together |
| `WV-PKG-1002` | The ZIP selection does not contain exactly one archive |
| `WV-PKG-1003` | The selection is not a supported ZIP or VPK input |

Lower-level parser codes may appear inside technical details. They are internal
and do not replace the public `WV-...` code.
