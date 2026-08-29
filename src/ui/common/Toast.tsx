import { Toast as BaseToast } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import './Toast.css';

export interface AppToastAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  primary?: boolean;
}

interface AppToastData {
  actions?: AppToastAction[];
  dismissible: boolean;
}

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
  tone?: 'default' | 'error';
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
      data: { actions, dismissible },
      onClose,
    });
  }, [actions, description, dismissible, id, onClose, open, priority, timeout, title, tone]);

  return null;
}

export function ToastViewport({ children }: ToastViewportProps) {
  return (
    <BaseToast.Provider toastManager={appToastManager} limit={3}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="toast-viewport">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager<AppToastData>();

  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      className="app-toast"
      toast={toast}
      swipeDirection={toast.data?.dismissible ? 'up' : []}
    >
      <BaseToast.Content className="app-toast-content">
        <div className="app-toast-copy">
          <BaseToast.Title />
          <BaseToast.Description />
        </div>

        {toast.data?.dismissible ? (
          <BaseToast.Close className="app-toast-dismiss" aria-label="Dismiss notification">
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </BaseToast.Close>
        ) : null}

        {toast.data?.actions?.length ? (
          <div className="app-toast-actions">
            {toast.data.actions.map((action) => (
              <BaseToast.Action
                key={action.label}
                className="app-toast-action"
                data-primary={action.primary ? 'true' : undefined}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.icon}
                {action.label}
              </BaseToast.Action>
            ))}
          </div>
        ) : null}
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}
