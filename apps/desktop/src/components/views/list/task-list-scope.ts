import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage, translateWithFallback, useTaskStore } from '@mindwtr/core';
import type { StoreActionResult, Task, TaskStatus } from '@mindwtr/core';

import { useOptionalKeybindings, type TaskListScope } from '../../../contexts/keybinding-context';
import { reportError } from '../../../lib/report-error';
import { showUndoToast } from '../../../lib/undo-registry';
import { undoTaskCompletion } from '../../../lib/undo-task-completion';
import { requestTaskRowAction, type TaskRowAction } from '../../../lib/task-row-actions';
import { useUiStore } from '../../../store/ui-store';

type TranslateFn = (key: string) => string;

export type TaskListScopeDeps = {
    /** The view's visible tasks, in display order. */
    getTasks: () => Task[];
    getSelectedIndex: () => number;
    setSelectedIndex: (index: number) => void;
    t: TranslateFn;
    addInputRef?: RefObject<HTMLElement | null>;
    /**
     * Called after keyboard navigation changes the selection. Views with their
     * own scroll/focus machinery (virtualized lists) override it; the default
     * scrolls the row into view and focuses its title.
     */
    revealSelected?: (task: Task) => void;
    /** Entering the list from the sidebar (ArrowRight / `l`, #890). */
    focusSelected?: () => boolean;
    /** Multi-select is view-owned state, so `x` only acts where it is wired. */
    toggleSelect?: (task: Task) => void;
};

function findTaskRow(taskId: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
}

// Keyboard actions must hit the row DOM focus is actually inside, not a stale
// index: clicking or tabbing into a row moves the user's cursor there without
// going through the view's selection state. This is deliberately AgendaView's
// pre-scope semantics (the old fallback's resolveFallbackSelectionIndex read
// activeElement first), applied to every view rather than only the unregistered
// ones. ListView is the only view that wires row clicks to a selection index;
// the rest have no index and no selection ring, so focus is their only signal
// and a pure-index rule would silently act on the wrong row.
function getFocusedTaskId(): string | null {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return active.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;
}

const FOCUSABLE_ROW_SELECTOR = 'button, [tabindex]:not([tabindex="-1"])';

function focusTaskRowControl(row: HTMLElement): void {
    // A comma selector returns the first match in document order, which is the
    // done button — Enter would then complete the task (#847). Prefer the title
    // toggle so Enter opens the task instead. Calendar chips carry data-task-id
    // on the control itself, so fall back to the row when it is focusable: the
    // descendant lookups find nothing there.
    const focusTarget = row.querySelector<HTMLElement>('[data-task-view-toggle]')
        ?? row.querySelector<HTMLElement>(FOCUSABLE_ROW_SELECTOR)
        ?? (row.matches(FOCUSABLE_ROW_SELECTOR) ? row : null);
    focusTarget?.focus();
}

function revealTaskRow(taskId: string): void {
    const row = findTaskRow(taskId);
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' });
    focusTaskRowControl(row);
}

/**
 * Moves keyboard focus to a task row's title toggle once the row is mounted.
 * Highlight reveals (global search, duplicate-and-reveal) land here: the
 * closing dialog restores focus to whatever held it before, so shortcuts and
 * arrow keys would keep acting on that stale row instead of the revealed task
 * (#1014). Bounded retries cover a virtualized row that mounts a frame after
 * its scroll was requested. Never steals focus from a text field.
 */
export function focusTaskRowWhenMounted(taskId: string, signal?: AbortSignal): void {
    if (typeof document === 'undefined' || signal?.aborted) return;
    let attempts = 0;
    const tryFocus = () => {
        if (signal?.aborted) return;
        const active = document.activeElement;
        if (
            active instanceof HTMLElement
            && active.closest('input, textarea, select, [contenteditable="true"]')
        ) return;
        const row = findTaskRow(taskId);
        if (row) {
            focusTaskRowControl(row);
            return;
        }
        if (attempts >= 8) return;
        attempts += 1;
        window.setTimeout(tryFocus, 50);
    };
    tryFocus();
}

// Store actions report failure by returning `{ success: false }` rather than
// throwing, so a bare `.then()` would announce a move that never happened.
function assertStoreActionSucceeded(result: unknown, fallbackMessage: string): void {
    const outcome = result as StoreActionResult | undefined;
    if (outcome && outcome.success === false) {
        throw new Error(outcome.error || fallbackMessage);
    }
}

export function createTaskListScope(deps: TaskListScopeDeps): TaskListScope {
    const translate = (key: string, fallback: string) => translateWithFallback(deps.t, key, fallback);

    // Resolves the acting task and writes the resolution back, so the view's
    // selection highlight and the keyboard target never disagree.
    const resolveIndex = (tasks: Task[]): number => {
        if (tasks.length === 0) return -1;
        const focusedId = getFocusedTaskId();
        const focusedIndex = focusedId ? tasks.findIndex((task) => task.id === focusedId) : -1;
        const index = focusedIndex >= 0
            ? focusedIndex
            : Math.min(Math.max(deps.getSelectedIndex(), 0), tasks.length - 1);
        if (index !== deps.getSelectedIndex()) deps.setSelectedIndex(index);
        return index;
    };

    const selectedTask = (): Task | null => {
        const tasks = deps.getTasks();
        const index = resolveIndex(tasks);
        return index < 0 ? null : tasks[index] ?? null;
    };

    const selectedRow = (): HTMLElement | null => {
        const task = selectedTask();
        return task ? findTaskRow(task.id) : null;
    };

    const reveal = (task: Task) => {
        if (deps.revealSelected) {
            deps.revealSelected(task);
            return;
        }
        revealTaskRow(task.id);
    };

    const move = (resolveNext: (index: number, count: number) => number) => {
        const tasks = deps.getTasks();
        const index = resolveIndex(tasks);
        if (index < 0) return;
        const nextIndex = Math.min(Math.max(resolveNext(index, tasks.length), 0), tasks.length - 1);
        deps.setSelectedIndex(nextIndex);
        const task = tasks[nextIndex];
        if (task) reveal(task);
    };

    const requestRowAction = (action: TaskRowAction) => {
        requestTaskRowAction(selectedRow(), action);
    };

    return {
        kind: 'taskList',
        selectNext: () => move((index, count) => Math.min(index + 1, count - 1)),
        selectPrev: () => move((index) => index - 1),
        selectFirst: () => move(() => 0),
        selectLast: () => move((_index, count) => count - 1),
        editSelected: () => {
            const row = selectedRow();
            if (!row) return;
            const trigger = row.matches('[data-task-edit-trigger]')
                ? row
                : row.querySelector<HTMLElement>('[data-task-edit-trigger]')
                    ?? row.querySelector<HTMLElement>('button, [role="button"], [tabindex]:not([tabindex="-1"])');
            if (!trigger) {
                row.click();
                return;
            }
            trigger.focus();
            trigger.click();
        },
        openSelected: () => {
            selectedRow()?.querySelector<HTMLElement>('[data-task-view-toggle]')?.click();
        },
        openQuickActions: () => {
            const trigger = selectedRow()?.querySelector<HTMLElement>('[data-task-quick-actions-trigger]');
            if (!trigger) return;
            trigger.focus();
            trigger.click();
        },
        toggleDoneSelected: () => {
            const task = selectedTask();
            if (!task) return;
            const previousStatus = task.status;
            const nextStatus: TaskStatus = previousStatus === 'done' ? 'inbox' : 'done';
            const wasFocusedToday = task.isFocusedToday === true;
            void Promise.resolve(useTaskStore.getState().moveTask(task.id, nextStatus))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to change task status');
                    if (nextStatus !== 'done' || previousStatus === 'done') return;
                    showUndoToast(formatTaskMarkedDoneMessage(deps.t, task.title), () => {
                        void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                            .catch((error) => reportError('Failed to undo task completion', error));
                    }, deps.t);
                })
                .catch((error) => reportError('Failed to change task status', error));
        },
        toggleSelectSelected: () => {
            const task = selectedTask();
            if (!task) return;
            deps.toggleSelect?.(task);
        },
        copySelected: async (includeDescription) => {
            const task = selectedTask();
            if (!task) return;
            try {
                const description = includeDescription && task.description?.trim() ? `\n\n${task.description}` : '';
                await navigator.clipboard.writeText(task.title + description);
                useUiStore.getState().showToast(translate('list.taskCopied', 'Task copied to clipboard'), 'success');
            } catch {
                useUiStore.getState().showToast(translate('list.taskCopyFailed', 'Could not copy task'), 'error');
            }
        },
        toggleFocusSelected: () => requestRowAction('toggle-focus'),
        renameSelected: () => requestRowAction('rename-title'),
        deleteSelected: () => {
            const task = selectedTask();
            if (!task) return;
            void Promise.resolve(useTaskStore.getState().deleteTask(task.id))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to delete task');
                    showUndoToast(translate('list.taskDeleted', 'Task deleted'), () => {
                        void useTaskStore.getState().restoreTask(task.id);
                    }, deps.t);
                })
                .catch((error) => reportError('Failed to delete task', error));
        },
        // Status chord (#860): `s` then a letter moves the selected task straight
        // to that status through the shared moveTask path (recurrence/completion
        // metadata applied by updateTask).
        setStatusSelected: (status: TaskStatus) => {
            const task = selectedTask();
            if (!task || task.status === status) return;
            const previousStatus = task.status;
            const wasFocusedToday = task.isFocusedToday === true;
            void Promise.resolve(useTaskStore.getState().moveTask(task.id, status))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to change task status');
                    showUndoToast(
                        status === 'done'
                            ? formatTaskMarkedDoneMessage(deps.t, task.title)
                            : formatTaskMovedMessage(deps.t, task.title, status),
                        () => {
                            // Completion has side effects (Today star, completedAt), so
                            // undoing into/out of done goes through the shared core rule.
                            if (status === 'done') {
                                void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                                    .catch((error) => reportError('Failed to undo task status change', error));
                                return;
                            }
                            void useTaskStore.getState().moveTask(task.id, previousStatus)
                                .catch((error) => reportError('Failed to undo task status change', error));
                        },
                        deps.t,
                    );
                })
                .catch((error) => reportError('Failed to change task status', error));
        },
        focusAddInput: () => {
            const input = deps.addInputRef?.current;
            if (!input) return false;
            input.focus();
            return true;
        },
        focusSelected: () => {
            if (deps.focusSelected) return deps.focusSelected();
            const task = selectedTask();
            if (!task) return false;
            reveal(task);
            return true;
        },
    };
}

/**
 * Registers a task list scope with the given registrar. The scope reads its
 * dependencies through a ref, so registration happens once per mount instead of
 * on every render.
 */
export function useRegisteredTaskListScope(
    register: (scope: TaskListScope | null) => void,
    deps: TaskListScopeDeps & { enabled?: boolean },
): void {
    const depsRef = useRef(deps);
    depsRef.current = deps;
    const enabled = deps.enabled !== false;

    const scope = useMemo(() => createTaskListScope({
        getTasks: () => depsRef.current.getTasks(),
        getSelectedIndex: () => depsRef.current.getSelectedIndex(),
        setSelectedIndex: (index) => depsRef.current.setSelectedIndex(index),
        t: (key) => depsRef.current.t(key),
        addInputRef: depsRef.current.addInputRef,
        revealSelected: depsRef.current.revealSelected && ((task) => depsRef.current.revealSelected?.(task)),
        focusSelected: depsRef.current.focusSelected && (() => depsRef.current.focusSelected?.() ?? false),
        toggleSelect: depsRef.current.toggleSelect && ((task) => depsRef.current.toggleSelect?.(task)),
    }), []);

    useEffect(() => {
        if (!enabled) return;
        register(scope);
        return () => register(null);
    }, [enabled, register, scope]);
}

const NO_KEYBINDING_REGISTRAR = () => {};

/** Registers the view's task list with the keybinding context. */
// Production mounts exactly one KeybindingProvider, in App.tsx, wrapping every view — so the
// no-registrar path below is only ever taken by tests that render a view in isolation. If you
// ever add a view outside that provider, make this throw instead: silently degrading a view's
// keyboard behaviour with nothing surfacing is the bug this module was written to remove.
export function useTaskListScope(deps: TaskListScopeDeps & { enabled?: boolean }): void {
    const keybindings = useOptionalKeybindings();
    useRegisteredTaskListScope(keybindings?.registerTaskListScope ?? NO_KEYBINDING_REGISTRAR, deps);
}
