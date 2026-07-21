import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourcePackageState, SourcePackageSummary } from '../ui/SourcePackagePanel';
import type { SourcePackage, SourcePackageOpenResult } from '../source/contracts';
import { isSupportedTexturePath, sourcePathExtension } from '../source/paths';
import { SourceTextureProvider } from '../source/provider';

type StaticPackageSummary = Omit<SourcePackageSummary, 'usedCount' | 'fallbackCount'>;

// Package entry indexes never change after opening. Provider activity is much
// more frequent than mounts, so retain the archive-derived fields and only
// recalculate the two live counters on each UI sync.
const staticSummaryCache = new WeakMap<SourcePackage, StaticPackageSummary>();

function importDiagnostic(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const detail = 'path' in error && typeof error.path === 'string' ? error.path : undefined;
  return { id: `import:${Date.now()}`, level: 'error' as const, message: error.message, detail };
}

function summaryFor(pkg: SourcePackage, provider: SourceTextureProvider): SourcePackageSummary {
  let summary = staticSummaryCache.get(pkg);
  if (!summary) {
    const counts = new Map<string, number>();
    for (const entry of pkg.entries.values()) {
      if (!entry.path.startsWith('materials/') || !isSupportedTexturePath(entry.path)) continue;
      const extension = sourcePathExtension(entry.path) ?? 'other';
      counts.set(extension, (counts.get(extension) ?? 0) + 1);
    }
    summary = {
      name: pkg.name,
      format: pkg.format,
      entryCount: pkg.entries.size,
      materialsByExtension: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([extension, count]) => ({ extension, count })),
    };
    staticSummaryCache.set(pkg, summary);
  }
  const snapshot = provider.snapshot();
  return {
    ...summary,
    usedCount: snapshot.usedPaths.size, fallbackCount: snapshot.fallbackIdentities.size,
  };
}

/** UI state and transactional ZIP/VPK mounting for the single active package. */
export function useSourcePackage(fallback: (ref: string) => string, onSuccessfulImport: () => void) {
  const [activityRevision, setActivityRevision] = useState(0);
  const [state, setState] = useState<Pick<SourcePackageState, 'status' | 'diagnostics' | 'summary'>>({ status: 'empty', diagnostics: [] });
  const [suggestedPaintkitId, setSuggestedPaintkitId] = useState<number | undefined>();
  const fallbackRef = useRef(fallback);
  const importOperationRef = useRef(0);
  fallbackRef.current = fallback;
  const providerRef = useRef<SourceTextureProvider | null>(null);
  if (!providerRef.current) providerRef.current = new SourceTextureProvider((ref) => fallbackRef.current(ref), () => setActivityRevision((value) => value + 1));
  const provider = providerRef.current;

  const sync = useCallback(() => {
    const snapshot = provider.snapshot();
    setState(snapshot.package
      ? { status: 'mounted', summary: summaryFor(snapshot.package, provider), diagnostics: [...snapshot.diagnostics] }
      : { status: 'empty', diagnostics: [...snapshot.diagnostics] });
  }, [provider]);
  useEffect(sync, [activityRevision, sync]);

  const onImport = useCallback((files: File[]) => {
    if (!files.length) return;
    const operation = ++importOperationRef.current;
    const format = files.some((file) => file.name.toLowerCase().endsWith('.vpk')) ? 'vpk' : 'zip';
    setState({ status: 'importing', summary: { name: files[0]?.name ?? 'package', format, entryCount: 0, materialsByExtension: [], usedCount: 0, fallbackCount: 0 }, diagnostics: [] });
    void (async () => {
      try {
        const zips = files.filter((file) => file.name.toLowerCase().endsWith('.zip'));
        const vpks = files.filter((file) => file.name.toLowerCase().endsWith('.vpk'));
        if (zips.length && vpks.length) throw new Error('Select either one ZIP package or one VPK file set, not both.');
        let opened: SourcePackageOpenResult;
        if (zips.length) {
          if (zips.length !== 1 || files.length !== 1) throw new Error('Select exactly one .zip package.');
          // Archive parsers are intentionally loaded only after a user picks a
          // package. @zip.js is sizeable and no normal viewing path needs it.
          const { openZipSourcePackage } = await import('../source/zip');
          opened = await openZipSourcePackage(zips[0]);
        } else if (vpks.length) {
          const { openVpkSourcePackage } = await import('../source/vpk');
          opened = await openVpkSourcePackage(vpks);
        } else {
          throw new Error('Select a .zip package or a complete .vpk file set.');
        }
        if (operation !== importOperationRef.current) { opened.package.dispose(); return; }
        provider.mount(opened.package, opened.diagnostics);
        setSuggestedPaintkitId(opened.suggestedPaintkitId);
        onSuccessfulImport();
        sync();
      } catch (cause) {
        if (operation !== importOperationRef.current) return;
        const snapshot = provider.snapshot();
        setState({
          status: snapshot.package ? 'mounted' : 'empty',
          summary: snapshot.package ? summaryFor(snapshot.package, provider) : undefined,
          diagnostics: [...snapshot.diagnostics, importDiagnostic(cause)],
        });
      }
    })();
  }, [onSuccessfulImport, provider, sync]);

  const onRemove = useCallback(() => {
    importOperationRef.current += 1;
    setSuggestedPaintkitId(undefined);
    provider.unmount();
    sync();
  }, [provider, sync]);
  useEffect(() => () => {
    importOperationRef.current += 1;
    provider.dispose();
  }, [provider]);
  return {
    provider,
    packageGeneration: provider.generation,
    suggestedPaintkitId,
    removePackage: onRemove,
    sourcePackage: useMemo<SourcePackageState>(() => ({ ...state, onImport, onRemove }), [state, onImport, onRemove]),
  };
}
