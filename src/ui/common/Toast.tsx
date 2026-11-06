import { Toast as BaseToast } from '@base-ui/react/toast';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';

interface AppToastAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  primary?: boolean;
}

interface AppToastData {
  actions?: AppToastAction[];
  dismissible: boolean;
  progress?: ToastProgress;
}

/** 0 to 1, or 'indeterminate' while the amount of work is not known yet. */
type ToastProgress = number | 'indeterminate';

interface ToastViewportProps {
  children: ReactNode;
}

interface ManagedToastProps {
  id: string;
  open: boolean;
  title: string;
  description: string;
  actions?: AppToastAction[];
  dismissible?: boolean;
  onClose?: () => void;
  priority?: 'low' | 'high';
  timeout?: number;
  tone?: 'default' | 'success' | 'error';
  /** Shows a progress bar and keeps the toast a fixed width while it updates. */
  progress?: ToastProgress;
}

const appToastManager = BaseToast.createToastManager<AppToastData>();

export function ManagedToast({
  id,
  open,
  title,
  description,
  actions,
  dismissible = false,
  onClose,
  priority = 'low',
  timeout = 0,
  tone = 'default',
  progress,
}: ManagedToastProps) {
  useEffect(() => {
    if (!open) {
      appToastManager.close(id);
      return;
    }

    appToastManager.add({
      id,
      title,
      description,
      timeout,
      priority,
      type: tone,
      data: { actions, dismissible, progress },
      onClose,
    });
  }, [actions, description, dismissible, id, onClose, open, priority, progress, timeout, title, tone]);

  return null;
}

export function ToastViewport({ children }: ToastViewportProps) {
  return (
    <BaseToast.Provider toastManager={appToastManager} limit={3}>
      {children}
      <BaseToast.Portal>
        {/* Mobile: toasts take the top edge, above the toolbar and clear of the notch, over every stage overlay. */}
        <BaseToast.Viewport className="pointer-events-none fixed top-14 left-1/2 z-1500 grid w-[min(420px,calc(100vw-24px))] -translate-x-1/2 justify-items-center gap-2 mobile:top-[calc(10px+env(safe-area-inset-top))] mobile:w-[min(420px,calc(100vw-20px-env(safe-area-inset-left)-env(safe-area-inset-right)))]">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastIcon({ tone }: { tone: string | undefined }) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info;
  const color = tone === 'error' ? 'text-fail' : tone === 'success' ? 'text-pass' : 'text-dim';
  return <Icon className={cn('mt-px flex-none', color)} size={16} aria-hidden="true" />;
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager<AppToastData>();

  return toasts.map((toast) => {
    const hasProgress = toast.data?.progress !== undefined;
    return (
      <BaseToast.Root
        key={toast.id}
        data-slot="toast"
        className={cn(
          'pointer-events-auto max-w-full translate-y-[var(--toast-swipe-movement-y,0px)] rounded-lg border border-strong bg-panel/96 p-3.5 text-text shadow-pop [transition:opacity_180ms_ease,translate_220ms_cubic-bezier(0.2,0.8,0.2,1)] data-ending-style:translate-y-[calc(var(--toast-swipe-movement-y,0px)-16px)] data-ending-style:opacity-0 data-starting-style:-translate-y-4 data-starting-style:opacity-0 data-[type=error]:border-[color-mix(in_srgb,var(--fail)_55%,var(--border-strong))] motion-reduce:transition-none',
          // Progress toasts keep one width, so the counter does not resize them.
          hasProgress ? 'w-[min(340px,100%)]' : 'w-fit mobile:w-full',
        )}
        toast={toast}
        swipeDirection={toast.data?.dismissible ? 'up' : []}
      >
        <BaseToast.Content className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3">
          <ToastIcon tone={toast.type} />
          <div className="min-w-0">
            <BaseToast.Title className="m-0 block text-14 leading-[1.3] font-bold" />
            <BaseToast.Description className={cn('mt-1 mb-0 text-13 leading-[1.45] text-dim', hasProgress && 'tabular-nums')} />
          </div>

          {toast.data?.dismissible ? (
            <BaseToast.Close aria-label="Dismiss notification" render={<Button variant="ghost" size="icon-md" className="-mt-1.5 -mr-1.5" data-slot="toast-dismiss" />}>
              <X aria-hidden="true" size={16} strokeWidth={2} />
            </BaseToast.Close>
          ) : null}

          {toast.data?.progress !== undefined ? <ToastProgressBar progress={toast.data.progress} /> : null}

          {toast.data?.actions?.length ? (
            <div className="col-span-full flex justify-end gap-2">
              {toast.data.actions.map((action) => (
                <BaseToast.Action
                  key={action.label}
                  disabled={action.disabled}
                  onClick={action.onClick}
                  render={<Button variant={action.primary ? 'primary' : 'secondary'} size="lg" className="mobile:min-h-9.5" />}
                >
                  {action.icon}
                  {action.label}
                </BaseToast.Action>
              ))}
            </div>
          ) : null}
        </BaseToast.Content>
      </BaseToast.Root>
    );
  });
}

function ToastProgressBar({ progress }: { progress: ToastProgress }) {
  const indeterminate = progress === 'indeterminate';
  const value = indeterminate ? 0 : Math.min(1, Math.max(0, progress));
  return (
    <div
      className="col-span-full h-1 overflow-hidden rounded-full bg-panel-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
    >
      <span
        className={cn(
          'block h-full origin-left rounded-[inherit] bg-accent transition-transform duration-200 ease-linear motion-reduce:transition-none',
          indeterminate && 'w-[35%] animate-toast-progress motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-35',
        )}
        style={indeterminate ? undefined : { transform: `scaleX(${value})` }}
      />
    </div>
  );
}
