import { useUiStore } from '../store/ui-store';

export function showSyncErrorToast(message: string, durationMs?: number): void {
    const ui = useUiStore.getState();
    if (ui.toasts.some((toast) => toast.tone === 'error' && toast.message === message)) return;
    if (durationMs === undefined) ui.showToast(message, 'error');
    else ui.showToast(message, 'error', durationMs);
}
