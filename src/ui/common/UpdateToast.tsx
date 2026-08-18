import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import './UpdateToast.css';

export function UpdateToast() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const handlePreloadError = (event: Event) => {
      event.preventDefault();
      setUpdateAvailable(true);
    };

    window.addEventListener('vite:preloadError', handlePreloadError);
    return () => window.removeEventListener('vite:preloadError', handlePreloadError);
  }, []);

  if (!updateAvailable) return null;

  return (
    <div className="update-toast" role="alert" aria-live="assertive">
      <div className="update-toast-copy">
        <strong>Update available</strong>
        <span>A newer version was deployed. Reload to continue.</span>
      </div>
      <button className="update-toast-action" type="button" onClick={() => window.location.reload()}>
        <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
        Reload
      </button>
    </div>
  );
}
