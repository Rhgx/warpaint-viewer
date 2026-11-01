import { useEffect, useState } from 'react';

const NOTICE_MS = 1200;

/** Copies text to the clipboard and briefly holds the outcome for inline button feedback. */
export function useCopyText() {
  const [notice, setNotice] = useState<'Copied' | 'Copy failed' | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied');
    } catch {
      setNotice('Copy failed');
    }
  };

  return { notice, copy };
}
