import { flushPendingSave, useTaskStore } from './store';
import { runAfterStoreWriteLock } from './data-transfer-transaction';
import type { Task } from './types';

type UndoResult = { success: true } | { success: false; error?: string; retryable: boolean };

/** Restore only the fields cancellation changes, leaving later edits alone. */
export function createTaskCancellationUndo(before: Task, cancelledAt: string | undefined): () => Promise<UndoResult> {
    const restoreFields: Partial<Task> = {
        status: before.status,
        cancelledAt: before.cancelledAt,
        completedAt: before.completedAt,
        isFocusedToday: before.isFocusedToday,
        focusOrder: before.focusOrder,
        boardOrder: before.boardOrder,
    };
    let written = false;
    let retryPersistence = false;
    let finished = false;
    let inFlight: Promise<UndoResult> | null = null;

    const matchesRestoredFields = (task: Task | undefined): boolean => !!task
        && !task.deletedAt && !task.purgedAt
        && Object.entries(restoreFields).every(([key, value]) => task[key as keyof Task] === value);
    const isStillRestored = (task: Task | undefined): boolean => !!task
        && !task.deletedAt && !task.purgedAt
        && task.status === before.status
        && task.cancelledAt === before.cancelledAt
        && task.completedAt === before.completedAt;

    const run = (): Promise<UndoResult> => runAfterStoreWriteLock(async () => {
        if (finished) return { success: true };
        if (!written) {
            const current = useTaskStore.getState()._tasksById.get(before.id);
            if (!cancelledAt || !current || current.deletedAt || current.purgedAt
                || current.status !== 'archived' || current.cancelledAt !== cancelledAt) {
                return { success: false, retryable: false };
            }
            let applied = false;
            try {
                const write = useTaskStore.getState().updateTask(before.id, restoreFields);
                // Capture an immediate optimistic write; the failure paths also
                // check again for stores that apply it after an earlier await.
                const immediate = useTaskStore.getState()._tasksById.get(before.id);
                applied = immediate !== current && matchesRestoredFields(immediate);
                const result = await write;
                written = result.success;
                if (!result.success) {
                    written = applied || matchesRestoredFields(useTaskStore.getState()._tasksById.get(before.id));
                    retryPersistence = written;
                    return { success: false, error: result.error, retryable: true };
                }
            } catch (error) {
                written = applied || matchesRestoredFields(useTaskStore.getState()._tasksById.get(before.id));
                retryPersistence = written;
                return { success: false, error: error instanceof Error ? error.message : undefined, retryable: true };
            }
        }
        try {
            if (!isStillRestored(useTaskStore.getState()._tasksById.get(before.id))) {
                return { success: false, retryable: false };
            }
            if (retryPersistence) await useTaskStore.getState().persistSnapshot();
            await flushPendingSave();
            if (!isStillRestored(useTaskStore.getState()._tasksById.get(before.id))) {
                return { success: false, retryable: false };
            }
            finished = true;
            return { success: true };
        } catch (error) {
            // An exhausted save may have dropped its queued snapshot. Requeue the
            // latest whole state on retry; never repeat the status mutation.
            retryPersistence = true;
            return { success: false, error: error instanceof Error ? error.message : undefined, retryable: true };
        }
    });
    return () => {
        if (inFlight) return inFlight;
        inFlight = run().finally(() => { inFlight = null; });
        return inFlight;
    };
}
