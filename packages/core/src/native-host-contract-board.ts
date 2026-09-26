/**
 * The native host contract for the Board screen. Kept in its own file and spread
 * into createNativeHostContract: other changes edit native-host-contract.ts in
 * parallel. The view is the React Native Board's, from board-view-model.ts.
 *
 * getBoardView reads the five columns under one revision, each with its first
 * `limit` cards; getBoardList pages a column's cards, or the filter sheet's tokens
 * and projects, under that revision. The host keeps the filter state the view
 * returns and sends it back, with a `filterEdit` to change it.
 *
 * runBoardAction writes with a request UUID: while a save is owed, a retry only
 * saves (native-request-receipts.ts). A move and Delete are target-state, so a
 * replay after a restart writes nothing; Duplicate uses its request UUID as the
 * copy ID and checks unchanged copy fields. Success means the change is saved.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import {
    BOARD_CARD_SWIPES,
    BOARD_DUE_DATE_PRESETS,
    EMPTY_BOARD_FILTER_STATE,
    applyBoardFilterEdit,
    buildBoardColumns,
    getBoardCard,
    getBoardCardText,
    getBoardFilterOptions,
    getBoardFilterSummary,
    getBoardProjectBadges,
    isBoardStatus,
    planBoardDrop,
    resolveBoardFilterState,
    selectBoardTasks,
    type BoardCard,
    type BoardCardAction,
    type BoardColumnTone,
    type BoardDuePreset,
    type BoardFilterEdit,
    type BoardFilterState,
    type BoardStatus,
} from './board-view-model';
import { matchesDuplicateSource } from './store-helpers';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, type NativeUnsavedWrite } from './native-request-receipts';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { useTaskStore } from './store';
import type { Task } from './types';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];
type Translate = (key: string) => string;

export type BoardViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => Translate;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
    requestIdPattern: RegExp;
};

/** The Board's filter state; missing keys are the empty state's. */
export type NativeBoardFilters = Partial<BoardFilterState>;
export type NativeBoardWindow<T> = { total: number; items: T[] };
export type NativeBoardCard = { row: NativeTaskRow; card: BoardCard; boardOrder: number | null };
export type NativeBoardColumn = {
    status: BoardStatus;
    label: string;
    tone: BoardColumnTone;
    /** The header badge: every card in the column. */
    count: number;
    /** The first `limit` cards; getBoardList pages the rest ('cards', status). */
    cards: NativeBoardCard[];
    /** "No tasks" in place of cards. */
    empty: string | null;
};
export type NativeBoardView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The effective filter state after `filterEdit`: send it back with reads, moves and paging. */
    filters: BoardFilterState;
    bar: {
        searchPlaceholder: string;
        searchQuery: string;
        /** The search box's clear button shows. */
        searchActive: boolean;
        /** The Clear button shows and the Filters button is tinted; Clear sends { type: 'clear' }. */
        active: boolean;
        clearLabel: string;
        /** "Filters" or "Filters (2)". */
        filterLabel: string;
    };
    sheet: {
        /** Tap sends { type: 'toggleToken', value } (none → included → excluded → none). */
        tokens: NativeBoardWindow<{ value: string; state: 'included' | 'excluded' | 'none' }>;
        /** Tap sends { type: 'toggleProject', value: id }. */
        projects: NativeBoardWindow<{ id: string; title: string; selected: boolean }>;
        /** The Any/All control shows once two tokens of a kind are included. */
        showContextMatchMode: boolean;
        showTagMatchMode: boolean;
        /** The sheet's chips (getBoardList pages 'chips'), then the Board's own (search and due date); pressing one sends its edit. */
        chips: NativeBoardWindow<NativeBoardChip>;
        additionalChips: { id: string; label: string; edit: BoardFilterEdit }[];
        /** The due-date section; a preset sends { type: 'toggleDuePreset', preset } and folds the section. */
        due: { label: string; summary: string; accessibilityLabel: string; presets: { preset: BoardDuePreset; label: string; selected: boolean }[] };
    };
    columns: NativeBoardColumn[];
    cardActions: {
        /** A tap opens the task editor on this tab. */
        editorTab: 'view';
        /** A swipe opens a panel and runs its actions in order, each as its own runBoardAction. */
        swipes: Record<'left' | 'right', { label: string; actions: readonly BoardCardAction[] }>;
        /** A failed duplicate's error toast: this title, the error's message. */
        errorTitle: string;
    };
};

export type NativeBoardChip = { id: string; label: string; excluded: boolean; edit: BoardFilterEdit };
export type NativeBoardList = 'cards' | 'tokens' | 'projects' | 'chips';

export type NativeBoardAction =
    /**
     * A drop. Into another column, leave `afterId` out: only the status changes and the
     * card keeps its board order, as on mobile. Inside its column, `afterId` is the card
     * it lands after (null: first) in the column as `filters` show it.
     */
    | { type: 'moveCard'; taskId: string; status: BoardStatus; afterId?: string | null; filters?: NativeBoardFilters }
    | { type: 'duplicateTask'; taskId: string }
    | { type: 'trashTask'; taskId: string };

export type NativeBoardActionResult = {
    /** False when the action had nothing to write. */
    changed: boolean;
    /** Duplicate: open the copy in the task editor. */
    open: { taskId: string; projectId: string | null; tab: 'task' } | null;
};

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const isTextList = (value: unknown): value is string[] => (
    Array.isArray(value) && value.length <= NATIVE_HOST_MAX_WINDOW && value.every((entry) => isText(entry))
);
const isMatchMode = (value: unknown) => value === 'all' || value === 'any';
const isDuePreset = (value: unknown): value is BoardDuePreset => BOARD_DUE_DATE_PRESETS.includes(value as BoardDuePreset);
const FILTER_CHECKS: Record<keyof BoardFilterState, (value: unknown) => boolean> = {
    searchQuery: (value) => isText(value, 2000),
    tokens: isTextList,
    excludedTokens: isTextList,
    projects: isTextList,
    contextMatchMode: isMatchMode,
    tagMatchMode: isMatchMode,
    duePreset: (value) => value === null || isDuePreset(value),
};
/** A partial state is completed from the empty one; unknown keys are refused. */
const readFilters = (value: unknown): BoardFilterState | null => {
    if (value === undefined) return EMPTY_BOARD_FILTER_STATE;
    if (!isObjectRecord(value)) return null;
    for (const [key, entry] of Object.entries(value)) {
        const check = FILTER_CHECKS[key as keyof BoardFilterState];
        if (!check || !check(entry)) return null;
    }
    return { ...EMPTY_BOARD_FILTER_STATE, ...(value as NativeBoardFilters) };
};
const isFilterEdit = (edit: unknown): edit is BoardFilterEdit => {
    if (!isObjectRecord(edit)) return false;
    switch (edit.type) {
        case 'toggleToken':
        case 'removeToken':
        case 'toggleProject':
            return isText(edit.value) && (edit.value as string).length > 0;
        case 'setSearch':
            return isText(edit.value, 2000);
        case 'setMatchMode':
            return (edit.kind === 'context' || edit.kind === 'tag') && isMatchMode(edit.value);
        case 'toggleDuePreset':
            return isDuePreset(edit.preset);
        case 'clearDuePreset':
        case 'clear':
            return true;
        default:
            return false;
    }
};
const isWindow = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
);
/** A short, stable key for the view's filters, so a page of one filter never continues another. */
const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};
/** A list the view pages: its total, and one window built only for the items it holds. */
const pagedList = <T, Item>(all: readonly T[], toItem: (entry: T) => Item) => ({
    total: all.length,
    page: (offset: number, limit: number): Item[] => all.slice(offset, offset + limit).map(toItem),
});
const firstPage = <Item,>(list: { total: number; page: (offset: number, limit: number) => Item[] }): NativeBoardWindow<Item> => (
    { total: list.total, items: list.page(0, NATIVE_HOST_MAX_WINDOW) }
);
// ponytail: the last 200 request IDs that entered the receipts; the receipts keep 50.
const ENTERED_LIMIT = 200;

export function createBoardViewMethods(deps: BoardViewDeps) {
    // Exact retries through the shared helper: a retry finishes a failed save and never writes twice.
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    // ponytail: one cached build, keyed by the revision and the filters; paging rebuilds nothing.
    let cache: { key: string; value: ReturnType<typeof buildBoard> } | null = null;

    /** The Board for a filter state, as mobile derives it from the store. */
    function buildBoard(input: BoardFilterState, now: Date) {
        const state = useTaskStore.getState();
        const t = deps.t();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
        // What useVisibleTaskContext shows, without Reference.
        const tasks = selectBoardTasks(state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter })));
        const badges = getBoardProjectBadges(state.projects, areaById);
        const options = getBoardFilterOptions({ tasks, projects: state.projects, areaFilter: resolvedAreaFilter, areaById, badges, t });
        const resolved = resolveBoardFilterState(input, {
            tokens: options.tokens, projectIds: options.projects.map((project) => project.id), getProjectLabel: options.getProjectLabel, t,
        });
        const filters = resolved.state;
        const summary = getBoardFilterSummary({ criteria: resolved.criteria, searchQuery: filters.searchQuery, t });
        const columns = buildBoardColumns({ tasks, criteria: resolved.criteria, searchQuery: filters.searchQuery, projects: state.projects, now, t });
        const cardText = getBoardCardText(t);
        const timeEstimatesEnabled = resolveFeatureFlags(state.settings).timeEstimates;
        const lists = {
            tokens: pagedList(options.tokens, (value) => ({
                value, state: filters.tokens.includes(value) ? 'included' as const : filters.excludedTokens.includes(value) ? 'excluded' as const : 'none' as const,
            })),
            projects: pagedList(options.projects, (project) => ({ ...project, selected: filters.projects.includes(project.id) })),
            chips: pagedList(resolved.chips, (chip): NativeBoardChip => ({ id: chip.id, label: chip.label, excluded: chip.excluded, edit: chip.edit as BoardFilterEdit })),
        };
        const view: Omit<NativeBoardView, 'version' | 'revision' | 'columns'> = {
            filters,
            bar: {
                searchPlaceholder: summary.searchPlaceholder,
                searchQuery: filters.searchQuery,
                searchActive: summary.searchActive,
                active: summary.active,
                clearLabel: summary.clearLabel,
                filterLabel: summary.filterLabel,
            },
            sheet: {
                tokens: firstPage(lists.tokens),
                projects: firstPage(lists.projects),
                showContextMatchMode: resolved.showContextMatchMode,
                showTagMatchMode: resolved.showTagMatchMode,
                chips: firstPage(lists.chips),
                additionalChips: summary.chips.map((chip) => ({
                    ...chip, edit: chip.id === 'board-search' ? { type: 'setSearch', value: '' } : { type: 'clearDuePreset' },
                })),
                due: summary.due,
            },
            cardActions: {
                editorTab: 'view',
                swipes: {
                    left: { label: cardText.duplicate, actions: BOARD_CARD_SWIPES.left.actions },
                    right: { label: cardText.delete, actions: BOARD_CARD_SWIPES.right.actions },
                },
                errorTitle: cardText.errorTitle,
            },
        };
        return { view, columns, lists, badges, timeEstimatesEnabled };
    }

    /** The Board for these filters (after an edit), with its revision; null for invalid input. */
    const readBoard = (input: Record<string, unknown>) => {
        const read = readFilters(input.filters);
        if (!read || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) return null;
        const edited = input.filterEdit === undefined ? read : applyBoardFilterEdit(read, input.filterEdit as BoardFilterEdit);
        const now = new Date();
        const base = deps.revision(now);
        const key = `${base}:${paramsKey(edited)}`;
        if (cache?.key !== key) cache = { key, value: buildBoard(edited, now) };
        // The resolved filters (selections no longer offered dropped) name the revision.
        return { now, board: cache.value, revision: `${base}:${paramsKey(cache.value.view.filters)}` };
    };

    const cards = (board: ReturnType<typeof buildBoard>, tasks: readonly Task[], now: Date): NativeBoardCard[] => {
        const rows = deps.rows(tasks, now);
        return tasks.map((task, index) => ({
            row: rows[index],
            card: getBoardCard(task, { badges: board.badges, timeEstimatesEnabled: board.timeEstimatesEnabled, t: deps.t() }),
            boardOrder: Number.isFinite(task.boardOrder) ? task.boardOrder as number : null,
        }));
    };

    // ---- Actions ---------------------------------------------------------------

    type Outcome = NativeHostResult<NativeBoardActionResult> | NativeUnsavedWrite<NativeBoardActionResult>;
    /** An action's checks: a refusal or nothing to write (`result`), or the write to run. */
    type Prepared = { result: Outcome } | { write: () => Promise<Outcome> };
    /** Nothing to write: the request's target state already holds (a replay after a restart lands here). */
    const unchanged: Prepared = { result: { ok: true, value: { changed: false, open: null } } };
    const refuse = (code: NativeHostErrorCode, message: string): Prepared => ({ result: fail(code, message) });
    const liveTask = (id: unknown) => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.deletedAt && !task.purgedAt ? task : undefined;
    };
    /**
     * Runs a store call. `changed` says whether the tasks changed: a reorder the store
     * reads as its current order writes nothing, and says so.
     */
    const written = async (call: Parameters<typeof runStoreWrite>[0], open: () => NativeBoardActionResult['open'] = () => null): Promise<Outcome> => {
        const before = useTaskStore.getState()._allTasks;
        const landed = await runStoreWrite(call);
        return settleWrite(landed, { changed: useTaskStore.getState()._allTasks !== before, open: open() });
    };

    const prepare = (action: NativeBoardAction, requestId: string): Prepared => {
        const store = useTaskStore.getState();
        switch (action.type) {
            case 'moveCard': {
                const filters = readFilters(action.filters);
                if (!isBoardStatus(action.status) || !filters
                    || !(action.afterId === undefined || action.afterId === null || isText(action.afterId))) {
                    return refuse('INVALID_INPUT', 'A task, a Board column, an optional card to land after and valid filters are required');
                }
                const task = liveTask(action.taskId);
                if (!task) return refuse('TASK_NOT_FOUND', 'Task not found');
                if (!isBoardStatus(task.status)) return refuse('INVALID_INPUT', 'The card is not on the Board');
                let columnIds: string[] = [];
                if (task.status !== action.status) {
                    if (action.afterId !== undefined) return refuse('INVALID_INPUT', 'A drop into another column has no position');
                } else if (action.afterId !== undefined) {
                    const { board } = readBoard({ filters })!;
                    columnIds = board.columns.find((column) => column.status === action.status)!.tasks.map((entry) => entry.id);
                    if (!columnIds.includes(task.id) || (action.afterId !== null && (action.afterId === task.id || !columnIds.includes(action.afterId)))) {
                        return refuse('INVALID_INPUT', 'The card and the card it lands after must be shown in that column');
                    }
                }
                const plan = planBoardDrop({ task, status: action.status, columnIds, afterId: action.afterId });
                if (!plan) return unchanged;
                return {
                    write: () => written(() => (plan.kind === 'status'
                        ? store.updateTask(plan.taskId, { status: plan.status })
                        : store.reorderBoardTasks(plan.status, plan.orderedIds, plan.taskId))),
                };
            }
            case 'trashTask': {
                const task = typeof action.taskId === 'string' ? store._tasksById.get(action.taskId) : undefined;
                if (!task || task.purgedAt) return refuse('TASK_NOT_FOUND', 'Task not found');
                if (task.deletedAt) return unchanged;
                return { write: () => written(() => store.deleteTask(task.id)) };
            }
            case 'duplicateTask': {
                const task = liveTask(action.taskId);
                if (!task) return refuse('TASK_NOT_FOUND', 'Task not found');
                const copy = store._tasksById.get(requestId);
                if (copy) {
                    // An edited copy cannot acknowledge a lost reply.
                    if (!matchesDuplicateSource(task, copy)) {
                        return refuse('INVALID_INPUT', 'The duplicate request ID does not match this source');
                    }
                    return { result: { ok: true, value: { changed: false, open: { taskId: copy.id, projectId: task.projectId ?? null, tab: 'task' } } } };
                }
                const { duplicateFailed } = getBoardCardText(deps.t());
                let createdId: string | undefined;
                // Mobile's toast: the store's refusal, else "could not duplicate".
                return {
                    write: () => written(async () => {
                        try {
                            const result = await store.duplicateTask(task.id, false, requestId);
                            createdId = result.id;
                            return result.success && result.id ? result : { success: false, error: result.error || duplicateFailed };
                        } catch {
                            return { success: false, error: duplicateFailed };
                        }
                    }, () => (createdId ? { taskId: createdId, projectId: task.projectId ?? null, tab: 'task' } : null)),
                };
            }
            default:
                return refuse('INVALID_INPUT', 'The Board does not offer that action');
        }
    };
    // Request IDs that entered the receipts, with their payloads, so a retry reaches its receipt first.
    const entered = new Map<string, string>();

    return {
        /**
         * The Board: five columns with their first `limit` cards, the filter bar and the
         * filter sheet. Send the returned `filters` back, with a `filterEdit` to change them.
         */
        getBoardView(input: { filters?: NativeBoardFilters; filterEdit?: BoardFilterEdit; limit: number }): NativeHostResult<NativeBoardView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const read = isObjectRecord(input) && isWindow({ offset: 0, limit: input.limit }) ? readBoard(input) : null;
            if (!read) return fail('INVALID_INPUT', 'Valid filters, a filter edit and a bounded limit are required');
            const { now, board, revision } = read;
            const limit = input.limit;
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    ...board.view,
                    columns: board.columns.map((column) => ({
                        status: column.status,
                        label: column.label,
                        tone: column.tone,
                        count: column.tasks.length,
                        cards: cards(board, column.tasks.slice(0, limit), now),
                        empty: column.empty,
                    })),
                },
            };
        },

        /**
         * A later window of a column's cards ('cards' with its status), or of the filter
         * sheet's 'tokens', 'projects' or 'chips'. Send the view's filters and its revision.
         */
        getBoardList(input: {
            filters?: NativeBoardFilters;
            list: NativeBoardList;
            status?: BoardStatus;
            offset: number;
            limit: number;
            revision: string;
        }): NativeHostResult<{ version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string; list: NativeBoardList; total: number; items: unknown[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const valid = isObjectRecord(input) && typeof input.revision === 'string' && isWindow(input)
                && (input.list === 'tokens' || input.list === 'projects' || input.list === 'chips' || (input.list === 'cards' && isBoardStatus(input.status)));
            const read = valid ? readBoard({ filters: input.filters }) : null;
            if (!read) return fail('INVALID_INPUT', 'The view\'s filters, a list (a column\'s status for cards), a valid window and its revision are required');
            if (read.revision !== input.revision) return fail('STALE_REVISION', 'The Board changed; read it again');
            const { board, now } = read;
            let total: number;
            let items: unknown[];
            if (input.list === 'cards') {
                const column = board.columns.find((entry) => entry.status === input.status)!;
                total = column.tasks.length;
                items = cards(board, column.tasks.slice(input.offset, input.offset + input.limit), now);
            } else {
                const list = board.lists[input.list];
                total = list.total;
                items = list.page(input.offset, input.limit);
            }
            return { ok: true, value: { version: NATIVE_HOST_CONTRACT_VERSION, revision: read.revision, list: input.list, total, items } };
        },

        /**
         * One Board action. Reuse `requestId` to retry: a completed request writes nothing
         * again. A move and Delete are target-state, so a replay after a restart finds the
         * card where it asked and writes nothing. `changed` is false when the store did not
         * change; a request with nothing to write neither saves nor keeps a receipt.
         *
         */
        async runBoardAction(input: { requestId: string; action: NativeBoardAction }): Promise<NativeHostResult<NativeBoardActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID and an action are required');
            }
            const action = input.action as NativeBoardAction;
            const requestId = input.requestId;
            const payload = JSON.stringify(['board', action]);
            // The receipts come first: a request that is running or owes its save only saves.
            // A new request that is refused or has nothing to write returns at once: no save, no receipt.
            const known = entered.get(requestId);
            if (known === undefined) {
                const prepared = prepare(action, requestId);
                if ('result' in prepared) return prepared.result as NativeHostResult<NativeBoardActionResult>;
                entered.set(requestId, payload);
                if (entered.size > ENTERED_LIMIT) entered.delete(entered.keys().next().value!);
            }
            const outcome = await receipts.run(requestId, payload, () => {
                const prepared = prepare(action, requestId);
                return 'result' in prepared ? Promise.resolve(prepared.result) : prepared.write();
            });
            // A write that did not land leaves no receipt; another payload under a known ID was refused and changes nothing.
            if (!outcome.ok && outcome.error.code !== 'SAVE_FAILED' && (known === undefined || known === payload)) entered.delete(requestId);
            return outcome;
        },
    };
}
