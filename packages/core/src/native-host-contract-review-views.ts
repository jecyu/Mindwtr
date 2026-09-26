/**
 * The native host contract for the Review screen, the Weekly Review and the
 * Daily Review. Kept in its own file and spread into createNativeHostContract:
 * other changes edit native-host-contract.ts in parallel. Every view is the
 * React Native screen's, from the same core models (review-utils.ts,
 * review-views-model.ts).
 *
 * Reads are windowed by NATIVE_HOST_MAX_WINDOW under one revision; nested lists
 * page through getWeeklyReviewList. Writes go through runReviewAction with a
 * request UUID: while a save is owed, a retry only saves (native-request-receipts.ts);
 * every action is target-state, so a replay after a restart writes nothing. Success
 * means the change is saved.
 *
 * A review wizard's place (pause and resume) is a device-local checkpoint, as
 * on mobile: each view returns the `checkpoint` string to store and the
 * checkpoints of the steps before and after it. Store the one you move to, send
 * it back to read that step, and delete it when the review is finished.
 *
 * Only functions read this module's imports from native-host-contract.ts, so
 * the import cycle between the two files is safe.
 */
import type { ReviewSnapshotItem, ReviewSuggestion } from './ai/types';
import { resolveAreaFilterSelection } from './area-filter';
import { buildBulkOrganizeTaskUpdates, type BulkOrganizeTaskUpdateInput } from './bulk-organize';
import { buildBulkTaskTokenUpdates, collectBulkTaskTokens } from './bulk-task-tokens';
import { safeParseDate, type DateFormatter } from './date';
import { formatI18nTemplate, tFallback } from './i18n';
import { formatListItemCountNoun } from './list-count';
import type { ExternalCalendarEvent } from './ics';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeListToast,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, type NativeUnsavedWrite } from './native-request-receipts';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { getTrashUndoLabel } from './trash-view-model';
import {
    buildReviewSteps,
    getDailyReviewBuckets,
    getExternalCalendarDaySummaries,
    getReviewOverviewGroups,
    isTaskDueForReview,
    type ReviewOverviewScope,
    getWeeklyReviewBuckets,
    resolveReviewStepSession,
    type ReviewStepFlags,
} from './review-utils';
import {
    DAILY_REVIEW_SESSION_STORAGE_KEY,
    LAST_WEEKLY_REVIEW_STORAGE_KEY,
    REVIEW_BULK_STATUSES,
    WEEKLY_REVIEW_PREVIEW,
    WEEKLY_REVIEW_SESSION_STORAGE_KEY,
    buildReviewShareText,
    buildReviewSuggestionUpdates,
    decorateReviewOverviewGroups,
    filterReviewSuggestions,
    formatDailyReviewStepLabel,
    getDailyReviewCalendarDay,
    getDailyReviewFollowUp,
    getDailyReviewSettings,
    getDailyReviewText,
    getDailyReviewTodayTasks,
    getReviewDay,
    getReviewExpansionControl,
    getReviewOverviewSortBy,
    getReviewOverviewText,
    getReviewStepRail,
    getWeeklyReviewCalendar,
    getWeeklyReviewCalendarNotice,
    getWeeklyReviewCompletion,
    getWeeklyReviewContextMoreLabel,
    getWeeklyReviewLabels,
    getWeeklyReviewProjects,
    getWeeklyReviewScheduledList,
    getWeeklyReviewSettings,
    getWeeklyReviewStale,
    isActionableReviewSuggestion,
    planDailyReviewFollowUp,
    planReviewProjectTask,
    restoreReviewSession,
    serializeReviewSession,
    titleDailyReviewSteps,
    titleWeeklyReviewSteps,
    toggleReviewExpandedId,
    type DailyReviewStepId,
    type ReviewStepRailItem,
    type ReviewTone,
    type WeeklyReviewCalendarDay,
    type WeeklyReviewLabels,
    type WeeklyReviewStepId,
} from './review-views-model';
import { useTaskStore } from './store';
import { getBulkTrashConfirmation, type ListConfirmation } from './trash-view-model';
import type { Task, TaskStatus } from './types';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];
type Translate = (key: string) => string;

export type ReviewViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => Translate;
    /** The user's date formatting (createDateFormatter); the only formatter this block uses. */
    formatDate: () => DateFormatter;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

/** The external calendar as the host fetched it (getReviewCalendarRange). Absent: no calendar. */
export type NativeReviewCalendar =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; events: ExternalCalendarEvent[] };

export type NativeReviewAction =
    | { type: 'setTaskStatus'; taskId: string; status: TaskStatus }
    | { type: 'trashTask'; taskId: string }
    | { type: 'restoreTasks'; taskIds: string[] }
    | { type: 'moveTasks'; taskIds: string[]; status: TaskStatus }
    | { type: 'trashTasks'; taskIds: string[] }
    | { type: 'addTag'; taskIds: string[]; tag: string }
    | { type: 'removeTags'; taskIds: string[]; tags: string[] }
    | { type: 'organizeTasks'; taskIds: string[]; input: BulkOrganizeTaskUpdateInput }
    /** Clears reached review reminders after a durable save; a replay is a no-op. */
    | { type: 'markReviewedTasks'; taskIds: string[] }
    /** The Weekly Review's project Add task (quick-add grammar). The requestId becomes the task id. */
    | { type: 'addProjectTask'; projectId: string; title: string }
    /** The Weekly Review's AI suggestions the user left selected. */
    | { type: 'applySuggestions'; suggestions: ReviewSuggestion[] }
    /** The Daily Review's Follow up today. Target state: a task already due for review is not written. */
    | { type: 'followUpToday'; taskId: string };

export type NativeReviewActionResult = {
    /** False when the action had nothing to write. */
    changed: boolean;
    toast: NativeListToast<NativeReviewAction> | null;
    /** addProjectTask: the new task, for Save & edit. */
    createdId: string | null;
};

export type NativeReviewOverviewItem =
    | {
        type: 'area';
        id: string;
        areaId: string | null;
        isUnassigned: boolean;
        title: string;
        summary: string;
        accessibilityLabel: string;
        /** Null: the theme tint. */
        color: string | null;
        expanded: boolean;
    }
    | {
        type: 'project';
        id: string;
        areaGroupId: string;
        projectId: string | null;
        isSingleActions: boolean;
        title: string;
        summary: string;
        accessibilityLabel: string;
        statusTone: ReviewTone | null;
        summaryTone: 'warning' | 'secondary';
        expanded: boolean;
    }
    | { type: 'task'; areaGroupId: string; projectGroupId: string; row: NativeTaskRow; selected: boolean };

export type NativeReviewExpansionEdit = { type: 'cycle' } | { type: 'toggleArea'; id: string } | { type: 'toggleProject'; id: string };

export type NativeReviewOverview = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The expansion after `expansionEdit`: send these back. */
    expandedAreaIds: string[];
    expandedProjectIds: string[];
    expansion: { label: string; disabled: boolean; allExpanded: boolean };
    total: number;
    items: NativeReviewOverviewItem[];
    empty: string | null;
    /** Present when a caller opts into the Review scope choice. Omission preserves the older overview. */
    scope?: { selected: ReviewOverviewScope; options: { id: ReviewOverviewScope; label: string }[]; help: string };
    startReview: { label: string; options: { id: 'daily' | 'weekly'; label: string }[]; cancelLabel: string };
    /** The bulk bar while tasks are selected. */
    bulk: {
        selectedIds: string[];
        countLabel: string;
        cancelLabel: string;
        actions: { id: 'organize' | 'moveTo' | 'addTag' | 'removeTag' | 'share' | 'delete' | 'markReviewed'; label: string; enabled: boolean }[];
        statuses: { status: TaskStatus; label: string }[];
        addTag: { title: string; placeholder: string; saveLabel: string; cancelLabel: string };
        removeTag: { title: string; placeholder: string; tags: string[] };
        deleteConfirmation: ListConfirmation;
        shareText: string;
    } | null;
};

/** The first NATIVE_HOST_MAX_WINDOW items of a nested list, of `total`. */
export type NativeReviewWindow<T> = { total: number; items: T[] };
export type NativeStaleProject = { id: string; title: string; daysLabel: string };
export type NativeWeeklyReviewList = 'staleProjects' | 'aiItems' | 'dayEvents' | 'contextTasks';

export type NativeWeeklyReviewItem =
    | { type: 'task'; row: NativeTaskRow; scheduled: boolean; projectId: string | null }
    /** A context's card: the first window of its tasks; getWeeklyReviewList pages the rest ('contextTasks', key: context). */
    | { type: 'context'; context: string; moreLabel: string | null; tasks: NativeReviewWindow<{ id: string; title: string }> }
    | {
        type: 'project';
        id: string;
        title: string;
        /** Null: the theme tint. */
        areaColor: string | null;
        badge: { label: string; color: string; background: string };
        countLabel: string;
        expanded: boolean;
    };

export type NativeWeeklyReview = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** Store this under `storageKey`; it resumes the review here this week. */
    checkpoint: string;
    storageKey: string;
    /** True when `checkpoint` came from a stored session of this week. */
    resumed: boolean;
    step: { id: WeeklyReviewStepId; title: string; indicator: string; progress: number };
    rail: ReviewStepRailItem[];
    /** The checkpoint to store for Back and Next; null when there is none. */
    back: { label: string; checkpoint: string | null };
    next: { label: string; checkpoint: string } | null;
    /** On the last step: store `lastReviewAt` under `lastReviewKey` and delete the checkpoint. */
    finish: { label: string; shareLabel: string; lastReviewKey: string; lastReviewAt: string } | null;
    labels: WeeklyReviewLabels & { closeLabel: string; processInbox: string; inboxHint: string; mindSweep: string; mindSweepTitle: string; mindSweepIntro: string };
    content:
        | { step: 'inbox'; countLabel: string | null; empty: string | null }
        /** getWeeklyReviewList pages 'staleProjects' and 'aiItems' (the AI analysis input). */
        | { step: 'stale'; projects: NativeReviewWindow<NativeStaleProject>; ai: { enabled: boolean; items: NativeReviewWindow<ReviewSnapshotItem> } }
        | {
            step: 'calendar';
            /** Loading, the fetch error or "no events" in place of the days. */
            notice: string | null;
            loading: boolean;
            /** getWeeklyReviewList pages a day's 'dayEvents' (key: the day's key). */
            days: (Omit<WeeklyReviewCalendarDay, 'dayStart' | 'events'> & { previewCount: number; events: NativeReviewWindow<WeeklyReviewCalendarDay['events'][number]> })[];
            tasks: { key: string; taskId: string; title: string; meta: string }[];
            tasksEmpty: string | null;
        }
        | { step: 'waiting' | 'someday'; empty: string | null; scheduled: { label: string; count: number } | null }
        | { step: 'contexts'; empty: string | null; previewCount: number }
        | { step: 'projects'; empty: string | null }
        | { step: 'completed'; week: { heading: string; rows: string[] } | null; checks: { good: boolean; text: string }[] };
    total: number;
    items: NativeWeeklyReviewItem[];
};

export type NativeDailyReviewItem = {
    row: NativeTaskRow;
    showFocusToggle: boolean;
    hideStatusBadge: boolean;
    followUp: { due: boolean; label: string; accessibilityLabel: string } | null;
};

export type NativeDailyReview = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    checkpoint: string;
    storageKey: string;
    resumed: boolean;
    title: string;
    step: { id: DailyReviewStepId; title: string; description: string; label: string };
    back: { label: string; checkpoint: string | null } | null;
    next: { label: string; checkpoint: string } | null;
    /** On the last step: delete the checkpoint. */
    finish: { label: string } | null;
    closeLabel: string;
    content:
        | {
            step: 'today';
            count: number;
            unit: string;
            calendar: { label: string; count: number; days: { title: string; notice: string | null; events: { key: string; title: string; timeLabel: string }[] }[] };
            empty: string | null;
        }
        | { step: 'focus'; count: number; unit: string; empty: string | null }
        | { step: 'inbox'; count: number; unit: string; processLabel: string | null; empty: string | null }
        | { step: 'waiting'; count: number; unit: string; empty: string | null }
        | { step: 'completed' };
    total: number;
    items: NativeDailyReviewItem[];
};

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const ID_LIMIT = 10_000;
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const isIdList = (value: unknown, allowEmpty = false): value is string[] => (
    Array.isArray(value) && value.length <= ID_LIMIT && (allowEmpty || value.length > 0)
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 500) && new Set(value).size === value.length
);
const isTextList = (value: unknown, limit = 500): value is string[] => (
    Array.isArray(value) && value.length <= limit && value.every((entry) => isText(entry))
);
const isPaging = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
    && (input.revision === undefined || typeof input.revision === 'string')
    && ((input.offset as number) === 0 || typeof input.revision === 'string')
);
const page = <T,>(items: readonly T[], input: { offset: number; limit: number }) => items.slice(input.offset, input.offset + input.limit);
const firstWindow = <T,>(items: readonly T[]) => ({ total: items.length, items: items.slice(0, NATIVE_HOST_MAX_WINDOW) });
/** A short, stable key for a view's own inputs, so a page of one step never continues another. */
const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};

const TASK_STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
const ORGANIZE_STATUSES: readonly TaskStatus[] = ['next', 'waiting', 'someday', 'reference', 'done'];
const SUGGESTION_ACTIONS = new Set(['someday', 'archive', 'breakdown', 'keep']);
const MAX_EVENTS = 2000;

const isEvent = (value: unknown): value is ExternalCalendarEvent => (
    isObjectRecord(value) && isText(value.id) && isText(value.sourceId) && isText(value.title, 2000)
    && isText(value.start, 64) && isText(value.end, 64) && typeof value.allDay === 'boolean'
);
const readCalendar = (value: unknown): { events: ExternalCalendarEvent[]; error: string | null; loading: boolean } | null => {
    if (value === undefined) return { events: [], error: null, loading: false };
    if (!isObjectRecord(value)) return null;
    if (value.status === 'loading') return { events: [], error: null, loading: true };
    if (value.status === 'error' && isText(value.message, 2000)) return { events: [], error: value.message, loading: false };
    if (value.status === 'ready' && Array.isArray(value.events) && value.events.length <= MAX_EVENTS && value.events.every(isEvent)) {
        return { events: value.events, error: null, loading: false };
    }
    return null;
};
const isDateValue = (value: unknown) => value === null || (isText(value, 64) && safeParseDate(value) !== null);
const isOrganizeInput = (value: unknown): value is BulkOrganizeTaskUpdateInput => {
    if (!isObjectRecord(value)) return false;
    const state = useTaskStore.getState();
    const optionalId = (key: string, exists: (id: string) => boolean) => (
        !(key in value) || value[key] === null || (isText(value[key]) && exists(value[key] as string))
    );
    return (value.status === undefined || ORGANIZE_STATUSES.includes(value.status as TaskStatus))
        // The projects the organize sheet offers.
        && optionalId('projectId', (id) => {
            const project = state._projectsById.get(id);
            return Boolean(project && isSelectableProjectForTaskAssignment(project));
        })
        && optionalId('sectionProjectId', (id) => Boolean(state._projectsById.get(id)))
        && optionalId('sectionId', (id) => Boolean(state._sectionsById.get(id) && !state._sectionsById.get(id)?.deletedAt))
        && optionalId('areaId', (id) => state.areas.some((area) => area.id === id && !area.deletedAt))
        && (value.contexts === undefined || isTextList(value.contexts))
        && (value.tags === undefined || isTextList(value.tags))
        && ['startTime', 'dueDate', 'reviewAt'].every((key) => !(key in value) || isDateValue(value[key]))
        && (!('assignedTo' in value) || value.assignedTo === null || isText(value.assignedTo))
        && Object.keys(value).every((key) => [
            'status', 'projectId', 'sectionId', 'sectionProjectId', 'areaId', 'contexts', 'tags', 'startTime', 'dueDate', 'reviewAt', 'assignedTo',
        ].includes(key));
};
const isSuggestion = (value: unknown): value is ReviewSuggestion => (
    isObjectRecord(value) && isText(value.id) && SUGGESTION_ACTIONS.has(value.action as string) && isText(value.reason, 2000)
);

export function createReviewViewMethods(deps: ReviewViewDeps) {
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
    // ponytail: one cached build per screen, keyed by the revision and the inputs; paging rebuilds nothing.
    const cache = new Map<string, { key: string; value: unknown }>();
    const cached = <T,>(screen: string, key: string, build: () => T): T => {
        const hit = cache.get(screen);
        if (hit?.key === key) return hit.value as T;
        const value = build();
        cache.set(screen, { key, value });
        return value;
    };
    /** A task that is live or in Trash; a purged task is gone. */
    const knownTask = (id: unknown): Task | undefined => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.purgedAt ? task : undefined;
    };
    const liveTask = (id: unknown) => {
        const task = knownTask(id);
        return task && !task.deletedAt ? task : undefined;
    };
    const doneToast = (count: number, t: Translate): NativeListToast<NativeReviewAction> => (
        { tone: 'success', title: t('common.done'), message: `${count} ${t('common.tasks')}`, undo: null }
    );
    type Outcome = NativeHostResult<NativeReviewActionResult> | NativeUnsavedWrite<NativeReviewActionResult>;
    /** Nothing to write: the request's target state already holds (a replay after a restart lands here). */
    const unchanged = (createdId: string | null = null): Outcome => ({ ok: true, value: { changed: false, toast: null, createdId } });
    /** Write, then answer: SAVE_FAILED carries the answer when the write landed and only its save failed. */
    const written = async (
        call: Parameters<typeof runStoreWrite>[0],
        toast: NativeReviewActionResult['toast'] = null,
        createdId: string | null = null,
    ): Promise<Outcome> => settleWrite(await runStoreWrite(call), { changed: true, toast, createdId });
    /** Keeps only updates that change their task. */
    const changing = (updates: { id: string; updates: Partial<Task> }[]) => updates.filter(({ id, updates: patch }) => {
        const task = knownTask(id);
        return !task || Object.entries(patch).some(([field, value]) => (
            JSON.stringify(task[field as keyof Task] ?? null) !== JSON.stringify(value ?? null)
        ));
    });

    // ---- Review overview -------------------------------------------------------

    const buildOverview = (base: string, scope: ReviewOverviewScope, now: Date) => cached('overview', `${base}:${scope}`, () => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const t = deps.t();
        const text = getReviewOverviewText(t);
        const groups = decorateReviewOverviewGroups(getReviewOverviewGroups({
            tasks: state.tasks,
            projects: state.projects,
            orderedAreas: areas,
            areaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
            sortBy: getReviewOverviewSortBy(state.settings),
            scope,
            now,
        }), { areaById: new Map(areas.map((area) => [area.id, area])), unassignedAreaColor: state.settings.appearance?.unassignedAreaColor, text, scope });
        return { groups, text, t };
    });

    const reviewOverview = (input: Record<string, unknown>): NativeHostResult<NativeReviewOverview> => {
        const edit = input.expansionEdit;
        const scope = (input.scope ?? 'all') as ReviewOverviewScope;
        if (!isPaging(input)
            || (scope !== 'due' && scope !== 'all')
            || (input.expandedAreaIds !== undefined && !isIdList(input.expandedAreaIds, true))
            || (input.expandedProjectIds !== undefined && !isIdList(input.expandedProjectIds, true))
            || (input.selectedIds !== undefined && !isIdList(input.selectedIds, true))
            || (edit !== undefined && !(isObjectRecord(edit) && (edit.type === 'cycle'
                || ((edit.type === 'toggleArea' || edit.type === 'toggleProject') && isText(edit.id)))))) {
            return fail('INVALID_INPUT', 'Valid expanded ids, an expansion edit, selected ids, offset, bounded limit and revision for later pages are required');
        }
        const now = new Date();
        const base = deps.revision(now);
        const { groups, text, t } = buildOverview(base, scope, now);
        let areaIds = new Set((input.expandedAreaIds as string[] | undefined) ?? []);
        let projectIds = new Set((input.expandedProjectIds as string[] | undefined) ?? []);
        const expansionEdit = edit as NativeReviewExpansionEdit | undefined;
        if (expansionEdit?.type === 'cycle') {
            const next = getReviewExpansionControl(groups, { areaIds, projectIds }, text).next;
            if (next) {
                areaIds = new Set(next.areaIds);
                projectIds = new Set(next.projectIds);
            }
        } else if (expansionEdit?.type === 'toggleArea') {
            areaIds = toggleReviewExpandedId(areaIds, expansionEdit.id);
        } else if (expansionEdit?.type === 'toggleProject') {
            projectIds = toggleReviewExpandedId(projectIds, expansionEdit.id);
        }
        const visibleIds = new Set(groups.flatMap((area) => area.projectGroups.flatMap((project) => project.tasks.map((task) => task.id))));
        const selectedIds = ((input.selectedIds as string[] | undefined) ?? []).filter((id) => visibleIds.has(id));
        const expandedAreaIds = Array.from(areaIds);
        const expandedProjectIds = Array.from(projectIds);
        const revision = `${base}:${paramsKey([scope, expandedAreaIds, expandedProjectIds, selectedIds])}`;
        if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'Review changed; restart paging from offset zero');
        // One flattened page source per revision and expansion; paging slices it.
        const view = cached('overview-page', revision, () => buildOverviewPage(groups, text, t, areaIds, projectIds, selectedIds, scope));
        const windowItems = page(view.entries, input as { offset: number; limit: number });
        const rows = deps.rows(windowItems.flatMap((entry) => (entry.type === 'task' ? [entry.task] : [])), now);
        const selected = new Set(selectedIds);
        let rowIndex = 0;
        return {
            ok: true,
            value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                expandedAreaIds,
                expandedProjectIds,
                expansion: view.expansion,
                total: view.entries.length,
                items: windowItems.map((entry): NativeReviewOverviewItem => (entry.type === 'task'
                    ? { type: 'task', areaGroupId: entry.areaGroupId, projectGroupId: entry.projectGroupId, row: rows[rowIndex++], selected: selected.has(entry.task.id) }
                    : entry)),
                empty: input.scope === undefined && view.empty ? text.empty : view.empty,
                ...(input.scope === undefined ? {} : { scope: {
                    selected: scope,
                    options: [{ id: 'due' as const, label: text.scopeDue }, { id: 'all' as const, label: text.scopeAll }],
                    help: scope === 'due' ? text.dueHelp : text.overviewHelp,
                } }),
                startReview: view.startReview,
                bulk: view.bulk,
            },
        };
    };

    type OverviewEntry = Exclude<NativeReviewOverviewItem, { type: 'task' }> | { type: 'task'; areaGroupId: string; projectGroupId: string; task: Task };
    const buildOverviewPage = (
        groups: ReturnType<typeof buildOverview>['groups'],
        text: ReturnType<typeof getReviewOverviewText>,
        t: Translate,
        areaIds: Set<string>,
        projectIds: Set<string>,
        selectedIds: string[],
        scope: ReviewOverviewScope,
    ) => {
        type Entry = OverviewEntry;
        const entries: Entry[] = groups.flatMap((group): Entry[] => [
            {
                type: 'area', id: group.id, areaId: group.areaId, isUnassigned: group.isUnassigned, title: group.title,
                summary: group.summary, accessibilityLabel: group.accessibilityLabel, color: group.color, expanded: areaIds.has(group.id),
            },
            ...(!areaIds.has(group.id) ? [] : group.projectGroups.flatMap((projectGroup): Entry[] => [
                {
                    type: 'project', id: projectGroup.id, areaGroupId: group.id, projectId: projectGroup.projectId,
                    isSingleActions: projectGroup.isSingleActions, title: projectGroup.title, summary: projectGroup.summaryText,
                    accessibilityLabel: projectGroup.accessibilityLabel, statusTone: projectGroup.statusTone,
                    summaryTone: projectGroup.summaryTone, expanded: projectIds.has(projectGroup.id),
                },
                ...(!projectIds.has(projectGroup.id) ? [] : projectGroup.tasks.map((task): Entry => (
                    { type: 'task', areaGroupId: group.id, projectGroupId: projectGroup.id, task }
                ))),
            ])),
        ]);
        const control = getReviewExpansionControl(groups, { areaIds, projectIds }, text);
        const hasSelection = selectedIds.length > 0;
        const tasksById = hasSelection ? Object.fromEntries(useTaskStore.getState().tasks.map((task) => [task.id, task])) : {};
        const removableTags = collectBulkTaskTokens(selectedIds, tasksById, 'tags');
        const bulk: NativeReviewOverview['bulk'] = !hasSelection ? null : {
            selectedIds,
            countLabel: `${selectedIds.length} ${text.selected}`,
            cancelLabel: text.cancel,
            actions: [
                { id: 'organize', label: text.organize, enabled: true },
                { id: 'moveTo', label: text.moveTo, enabled: true },
                ...(scope === 'due' ? [{ id: 'markReviewed' as const, label: text.markReviewed, enabled: true }] : []),
                { id: 'addTag', label: text.addTag, enabled: true },
                { id: 'removeTag', label: text.removeTag, enabled: removableTags.length > 0 },
                { id: 'share', label: text.share, enabled: true },
                { id: 'delete', label: text.delete, enabled: true },
            ],
            statuses: REVIEW_BULK_STATUSES.map((status) => ({ status, label: t(`status.${status}`) })),
            addTag: { title: text.addTag, placeholder: text.tagsLabel, saveLabel: text.save, cancelLabel: text.cancel },
            removeTag: { title: text.removeTag, placeholder: text.tagPlaceholder, tags: removableTags },
            deleteConfirmation: getBulkTrashConfirmation(t),
            shareText: buildReviewShareText(selectedIds.map((id) => tasksById[id])),
        };
        return {
            entries,
            expansion: { label: control.label, disabled: control.disabled, allExpanded: control.allExpanded },
            empty: groups.length === 0 ? (scope === 'due' ? text.dueEmpty : text.overviewEmpty) : null,
            startReview: {
                label: text.startReview,
                options: [{ id: 'daily' as const, label: text.dailyReview }, { id: 'weekly' as const, label: text.weeklyReview }],
                cancelLabel: text.cancel,
            },
            bulk,
        };
    };

    // ---- Weekly Review ---------------------------------------------------------

    const buildWeekly = (base: string, checkpoint: string | null, calendar: NonNullable<ReturnType<typeof readCalendar>>, expandedProjectId: string | null, now: Date) => (
        cached('weekly', `${base}:${paramsKey([checkpoint, calendar, expandedProjectId])}`, () => {
            const state = useTaskStore.getState();
            const t = deps.t();
            const formatDate = deps.formatDate();
            const labels = getWeeklyReviewLabels(t);
            const { aiEnabled, includeContextStep, weekStart } = getWeeklyReviewSettings(state.settings);
            const buckets = getWeeklyReviewBuckets(state.tasks, state.projects, { now, weekStart });
            const days = getExternalCalendarDaySummaries(calendar.events, 7, now);
            const flags = buildReviewSteps(buckets, {
                kind: 'weekly', includeContextStep, externalCalendarDayCount: days.length, externalCalendarHasError: Boolean(calendar.error),
                externalCalendarLoading: calendar.loading,
            });
            const steps = titleWeeklyReviewSteps(flags, labels);
            const { session, resumed } = restoreReviewSession<WeeklyReviewStepId>('weekly', checkpoint, { now, weekStart });
            const resolved = resolveReviewStepSession(steps, session.step);
            const step = resolved.displayedStep;
            const at = (id: WeeklyReviewStepId) => serializeReviewSession({ step: id, startedAt: session.startedAt });
            const title = steps[resolved.currentStepIndex].title;
            // Task rows are built when paged; other items are ready.
            type Entry = { kind: 'task'; task: Task; scheduled: boolean; projectId: string | null } | { kind: 'item'; item: NativeWeeklyReviewItem };
            const entries: Entry[] = [];
            const pushTask = (task: Task, scheduled = false, projectId: string | null = null) => {
                entries.push({ kind: 'task', task, scheduled, projectId });
            };
            // Nested lists, whole: views carry their first window, getWeeklyReviewList pages them.
            const lists = new Map<string, readonly unknown[]>();
            const nested = <T,>(key: string, items: readonly T[]) => {
                lists.set(key, items);
                return firstWindow(items);
            };
            let content: NativeWeeklyReview['content'];
            if (step === 'inbox') {
                buckets.inbox.forEach((task) => pushTask(task));
                content = {
                    step,
                    countLabel: buckets.inbox.length > 0 ? formatI18nTemplate(labels.summaryInboxCount, { count: buckets.inbox.length }) : null,
                    empty: buckets.inbox.length === 0 ? labels.inboxEmpty : null,
                };
            } else if (step === 'stale') {
                const stale = getWeeklyReviewStale(buckets.staleItems, state.tasks, labels);
                stale.tasks.forEach((task) => pushTask(task));
                content = {
                    step,
                    projects: nested('staleProjects', stale.projects),
                    ai: { enabled: aiEnabled, items: nested('aiItems', aiEnabled ? buckets.staleItems : []) },
                };
            } else if (step === 'calendar') {
                const view = getWeeklyReviewCalendar(days, buckets.calendarItems, labels, formatDate);
                content = {
                    step,
                    notice: getWeeklyReviewCalendarNotice({ loading: calendar.loading, error: calendar.error, dayCount: days.length }, labels),
                    loading: calendar.loading,
                    days: calendar.loading || calendar.error ? [] : view.days.map(({ dayStart: _dayStart, events, ...day }) => ({
                        ...day, previewCount: WEEKLY_REVIEW_PREVIEW.dayEvents, events: nested(`dayEvents:${day.key}`, events),
                    })),
                    tasks: view.tasks.map(({ key, task, title: taskTitle, meta }) => ({ key, taskId: task.id, title: taskTitle, meta })),
                    tasksEmpty: view.tasks.length === 0 ? labels.calendarTasksEmpty : null,
                };
            } else if (step === 'waiting' || step === 'someday') {
                const list = getWeeklyReviewScheduledList(step === 'waiting' ? buckets.waitingGroups : buckets.somedayGroups, labels);
                if (list.total > 0) {
                    list.visible.forEach((task) => pushTask(task));
                    list.scheduled.forEach((task) => pushTask(task, true));
                }
                content = {
                    step,
                    empty: list.total === 0 ? (step === 'waiting' ? labels.nothingWaiting : labels.listEmpty) : null,
                    scheduled: list.total > 0 && list.scheduled.length > 0 ? { label: list.scheduledLabel, count: list.scheduled.length } : null,
                };
            } else if (step === 'contexts') {
                buckets.contextGroups.forEach((group) => entries.push({ kind: 'item', item: {
                    type: 'context',
                    context: group.context,
                    moreLabel: getWeeklyReviewContextMoreLabel(group.tasks.length, labels),
                    tasks: nested(`contextTasks:${group.context}`, group.tasks.map((task) => ({ id: task.id, title: task.title }))),
                } }));
                content = { step, empty: buckets.contextGroups.length === 0 ? labels.contextsEmpty : null, previewCount: WEEKLY_REVIEW_PREVIEW.contextTasks };
            } else if (step === 'projects') {
                const areaById = new Map(state.areas.map((area) => [area.id, area]));
                getWeeklyReviewProjects(buckets.projectEntries, areaById, labels).forEach((entry) => {
                    const expanded = entry.project.id === expandedProjectId;
                    entries.push({ kind: 'item', item: {
                        type: 'project', id: entry.project.id, title: entry.project.title, areaColor: entry.areaColor,
                        badge: entry.badge, countLabel: entry.countLabel, expanded,
                    } });
                    if (expanded) entry.tasks.forEach((task) => pushTask(task, false, entry.project.id));
                });
                content = { step, empty: buckets.projectEntries.length === 0 ? labels.noActiveProjects : null };
            } else {
                const completion = getWeeklyReviewCompletion(buckets, state.settings, labels);
                content = { step: 'completed', week: completion.week, checks: completion.checks };
            }
            return {
                checkpoint: at(step),
                resumed,
                step: { id: step, title, indicator: `${resolved.currentStepIndex + 1}/${steps.length}`, progress: resolved.progress },
                rail: getReviewStepRail(steps, step, resolved.currentStepIndex),
                back: { label: labels.back, checkpoint: resolved.previousStep ? at(resolved.previousStep) : null },
                next: step === 'completed' ? null : { label: labels.next, checkpoint: at(resolved.nextStep ?? step) },
                finish: step === 'completed' ? {
                    label: labels.finish, shareLabel: t('shareCard.action'), lastReviewKey: LAST_WEEKLY_REVIEW_STORAGE_KEY, lastReviewAt: now.toISOString(),
                } : null,
                labels: {
                    ...labels,
                    closeLabel: tFallback(t, 'common.close', 'Close'),
                    processInbox: t('inbox.processButton'),
                    inboxHint: t('dailyReview.inboxDesc'),
                    mindSweep: t('mindSweep.launchButton'),
                    mindSweepTitle: t('mindSweep.title'),
                    mindSweepIntro: t('mindSweep.intro'),
                },
                content,
                entries,
                lists,
            };
        })
    );

    /** The weekly view for these inputs, with its revision; null for invalid inputs. */
    const readWeekly = (input: Record<string, unknown>) => {
        const calendar = readCalendar(input.calendar);
        if (!calendar
            || (input.checkpoint !== undefined && input.checkpoint !== null && !isText(input.checkpoint, 1000))
            || (input.expandedProjectId !== undefined && input.expandedProjectId !== null && !isText(input.expandedProjectId))) {
            return null;
        }
        const now = new Date();
        const base = deps.revision(now);
        const view = buildWeekly(base, (input.checkpoint as string | null | undefined) ?? null, calendar, (input.expandedProjectId as string | null | undefined) ?? null, now);
        return { now, view, revision: `${base}:${paramsKey([view.checkpoint, calendar, input.expandedProjectId ?? null])}` };
    };

    const weeklyReview = (input: Record<string, unknown>): NativeHostResult<NativeWeeklyReview> => {
        const read = isPaging(input) ? readWeekly(input) : null;
        if (!read) {
            return fail('INVALID_INPUT', 'A checkpoint or null, a calendar, an expanded project, offset, bounded limit and revision for later pages are required');
        }
        const { now, view, revision } = read;
        if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'The review changed; restart paging from offset zero');
        const windowEntries = page(view.entries, input as { offset: number; limit: number });
        const rows = deps.rows(windowEntries.flatMap((entry) => (entry.kind === 'task' ? [entry.task] : [])), now);
        let rowIndex = 0;
        const { entries: _entries, lists: _lists, ...rest } = view;
        return {
            ok: true,
            value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                storageKey: WEEKLY_REVIEW_SESSION_STORAGE_KEY,
                ...rest,
                total: view.entries.length,
                items: windowEntries.map((entry): NativeWeeklyReviewItem => (entry.kind === 'task'
                    ? { type: 'task', row: rows[rowIndex++], scheduled: entry.scheduled, projectId: entry.projectId }
                    : entry.item)),
            },
        };
    };

    // ---- Daily Review ----------------------------------------------------------

    const buildDaily = (base: string, checkpoint: string | null, calendar: NonNullable<ReturnType<typeof readCalendar>>, now: Date) => (
        cached('daily', `${base}:${paramsKey([checkpoint, calendar])}`, () => {
            const state = useTaskStore.getState();
            const t = deps.t();
            const formatDate = deps.formatDate();
            const { sortBy, includeFocusStep, focusTaskLimit } = getDailyReviewSettings(state.settings);
            const text = getDailyReviewText(t, focusTaskLimit);
            const today = getReviewDay(now);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const days = [today, tomorrow].map((day) => getDailyReviewCalendarDay(calendar.events, day, text, formatDate));
            const buckets = getDailyReviewBuckets(state.tasks, state.projects, { now: today, sortBy, sections: state.sections });
            const flags: ReviewStepFlags[] = buildReviewSteps(buckets, {
                kind: 'daily', includeFocusStep,
                todayCalendarEventCount: days[0].count, tomorrowCalendarEventCount: days[1].count,
                externalCalendarHasError: Boolean(calendar.error), externalCalendarLoading: calendar.loading,
            });
            const steps = titleDailyReviewSteps(flags, t);
            const { session, resumed } = restoreReviewSession<DailyReviewStepId>('daily', checkpoint, { now });
            const resolved = resolveReviewStepSession(steps, session.step);
            const step = resolved.displayedStep;
            const at = (id: DailyReviewStepId) => serializeReviewSession({ step: id, startedAt: session.startedAt });
            const index = Math.max(0, resolved.activeStepIndex);
            const current = resolved.activeSteps[index];
            const item = (task: Task, flagsFor: Partial<Omit<NativeDailyReviewItem, 'row'>> = {}) => ({
                task, showFocusToggle: false, hideStatusBadge: false, followUp: null, ...flagsFor,
            });
            let items: (Omit<NativeDailyReviewItem, 'row'> & { task: Task })[] = [];
            let content: NativeDailyReview['content'];
            if (step === 'today') {
                items = getDailyReviewTodayTasks(buckets).map((task) => item(task));
                const notice = calendar.loading ? text.loading : calendar.error;
                content = {
                    step, count: items.length, unit: formatListItemCountNoun(items.length, 'task', t),
                    calendar: {
                        label: text.events,
                        count: days[0].count + days[1].count,
                        days: days.map((day) => ({
                            title: day.title,
                            notice: notice ?? (day.count === 0 ? text.noEvents : null),
                            events: notice ? [] : day.events,
                        })),
                    },
                    empty: items.length === 0 ? text.todayEmpty : null,
                };
            } else if (step === 'focus') {
                items = buckets.focusCandidates.map((task) => item(task, { showFocusToggle: true, hideStatusBadge: true }));
                content = { step, count: buckets.focused.length, unit: text.focusSelected, empty: items.length === 0 ? text.focusEmpty : null };
            } else if (step === 'inbox') {
                items = buckets.inbox.map((task) => item(task));
                content = {
                    step, count: items.length, unit: formatListItemCountNoun(items.length, 'task', t),
                    processLabel: items.length > 0 ? text.processInbox : null, empty: items.length === 0 ? text.inboxEmpty : null,
                };
            } else if (step === 'waiting') {
                items = buckets.waiting.map((task) => item(task, { followUp: getDailyReviewFollowUp(task, today, text) }));
                content = { step, count: items.length, unit: formatListItemCountNoun(items.length, 'task', t),
                    empty: items.length === 0 ? text.waitingEmpty : null };
            } else {
                content = { step: 'completed' };
            }
            return {
                checkpoint: at(step),
                resumed,
                title: text.title,
                step: {
                    id: step,
                    title: current?.title ?? text.completeTitle,
                    description: current?.description ?? '',
                    label: formatDailyReviewStepLabel(t, index, resolved.activeSteps.length),
                },
                back: step === 'completed' ? null : { label: text.back, checkpoint: resolved.previousStep ? at(resolved.previousStep) : null },
                next: step === 'completed' ? null : { label: text.next, checkpoint: at(resolved.nextStep ?? step) },
                finish: step === 'completed' ? { label: text.finish } : null,
                closeLabel: text.close,
                content,
                items,
            };
        })
    );

    const dailyReview = (input: Record<string, unknown>): NativeHostResult<NativeDailyReview> => {
        const calendar = readCalendar(input.calendar);
        if (!isPaging(input) || !calendar || (input.checkpoint !== undefined && input.checkpoint !== null && !isText(input.checkpoint, 1000))) {
            return fail('INVALID_INPUT', 'A checkpoint or null, a calendar, offset, bounded limit and revision for later pages are required');
        }
        const now = new Date();
        const base = deps.revision(now);
        const view = buildDaily(base, (input.checkpoint as string | null | undefined) ?? null, calendar, now);
        const revision = `${base}:${paramsKey([view.checkpoint, calendar])}`;
        if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'The review changed; restart paging from offset zero');
        const windowItems = page(view.items, input as { offset: number; limit: number });
        const rows = deps.rows(windowItems.map((entry) => entry.task), now);
        const { items: _items, ...rest } = view;
        return {
            ok: true,
            value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                storageKey: DAILY_REVIEW_SESSION_STORAGE_KEY,
                ...rest,
                total: view.items.length,
                items: windowItems.map(({ task: _task, ...entry }, index) => ({ ...entry, row: rows[index] })),
            },
        };
    };

    // ---- Actions ---------------------------------------------------------------

    /**
     * One action, target-state: the receipts cover a retry while a save is owed; a
     * replay after that (a restart, an eviction) finds its target state and writes nothing.
     */
    const perform = async (requestId: string, action: NativeReviewAction): Promise<Outcome> => {
        const t = deps.t();
        const store = useTaskStore.getState();
        const tasksById = Object.fromEntries(store.tasks.map((task) => [task.id, task]));
        const everyLive = (ids: unknown): ids is string[] => isIdList(ids) && ids.every((id) => liveTask(id));
        const everyKnown = (ids: unknown): ids is string[] => isIdList(ids) && ids.every((id) => knownTask(id));
        switch (action.type) {
            case 'setTaskStatus': {
                if (!TASK_STATUSES.includes(action.status)) return fail('INVALID_INPUT', 'A task status is required');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.status === action.status) return unchanged();
                return written(() => store.updateTask(task.id, { status: action.status }));
            }
            case 'trashTask': {
                const task = knownTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.deletedAt) return unchanged();
                // The row's delete: moved to Trash at once, with Undo.
                return written(() => store.deleteTask(task.id), {
                    tone: 'info', title: null, message: tFallback(t, 'list.taskDeleted', 'Task deleted'),
                    undo: { label: tFallback(t, 'common.undo', 'Undo'), action: { type: 'restoreTasks', taskIds: [task.id] } },
                });
            }
            case 'restoreTasks': {
                if (!everyKnown(action.taskIds)) return fail('INVALID_INPUT', 'Every task must be live or in Trash');
                const trashed = action.taskIds.filter((id) => knownTask(id)?.deletedAt);
                if (trashed.length === 0) return unchanged();
                return written(() => Promise.all(trashed.map((id) => store.restoreTask(id))));
            }
            case 'moveTasks': {
                if (!REVIEW_BULK_STATUSES.includes(action.status) || !everyLive(action.taskIds)) {
                    return fail('INVALID_INPUT', 'A bulk status and tasks that exist are required');
                }
                const moving = action.taskIds.filter((id) => liveTask(id)!.status !== action.status);
                if (moving.length === 0) return unchanged();
                // Mobile counts the selection.
                return written(() => store.batchMoveTasks(moving, action.status), doneToast(action.taskIds.length, t));
            }
            case 'markReviewedTasks': {
                if (!everyLive(action.taskIds)) return fail('INVALID_INPUT', 'Tasks that exist are required');
                const now = new Date();
                const due = action.taskIds.filter((id) => isTaskDueForReview(liveTask(id)!, now));
                if (due.length === 0) return unchanged();
                return written(() => store.batchUpdateTasks(due.map((id) => ({ id, updates: { reviewAt: undefined } }))));
            }
            case 'trashTasks': {
                if (!everyKnown(action.taskIds)) return fail('INVALID_INPUT', 'Every task must be live or in Trash');
                const live = action.taskIds.filter((id) => liveTask(id));
                if (live.length === 0) return unchanged();
                return written(() => store.batchDeleteTasks(live), {
                    ...doneToast(live.length, t),
                    undo: { label: getTrashUndoLabel(t), action: { type: 'restoreTasks', taskIds: live } },
                });
            }
            case 'addTag':
            case 'removeTags':
            case 'organizeTasks': {
                if (!everyLive(action.taskIds)
                    || (action.type === 'addTag' && (!isText(action.tag) || !action.tag.trim()))
                    || (action.type === 'removeTags' && (!isTextList(action.tags) || action.tags.length === 0))
                    || (action.type === 'organizeTasks' && !isOrganizeInput(action.input))) {
                    return fail('INVALID_INPUT', 'Tasks that exist and a valid tag, tags or organize choice are required');
                }
                const updates = changing(action.type === 'organizeTasks'
                    ? buildBulkOrganizeTaskUpdates(action.taskIds, tasksById, action.input)
                    : action.type === 'addTag'
                        ? buildBulkTaskTokenUpdates(action.taskIds, tasksById, 'tags', action.tag.trim(), 'add')
                        : buildBulkTaskTokenUpdates(action.taskIds, tasksById, 'tags', action.tags, 'remove'));
                if (updates.length === 0) return unchanged();
                return written(() => store.batchUpdateTasks(updates), doneToast(updates.length, t));
            }
            case 'addProjectTask': {
                const project = isText(action.projectId) ? store._projectsById.get(action.projectId) : undefined;
                if (!project || project.deletedAt || !isText(action.title, 10_000) || !action.title.trim()) {
                    return fail('INVALID_INPUT', 'A project that exists and a task title are required');
                }
                const plan = planReviewProjectTask({
                    title: action.title, projectId: project.id, projects: store.projects, areas: store.areas,
                    settings: store.settings, tasks: store.tasks, people: store.people,
                });
                if (!plan) return fail('INVALID_INPUT', 'A task title is required');
                // The request ID is the task's ID: a replay finds the task this request made,
                // and anything else under that ID is refused.
                const id = requestId.toLowerCase();
                const existing = store._allTasks.find((task) => task.id === id);
                if (existing) {
                    const same = !existing.deletedAt && existing.title === plan.title
                        && (existing.projectId ?? null) === (plan.props.projectId ?? null)
                        && (existing.sectionId ?? null) === (plan.props.sectionId ?? null)
                        && existing.status === plan.props.status;
                    return same ? unchanged(id) : fail('INVALID_INPUT', 'Request ID already belongs to another task');
                }
                return written(async () => {
                    const result = await store.addTask(plan.title, plan.props, { captureId: requestId });
                    return result.success && result.id !== id ? { success: false, error: 'Task creation failed' } : result;
                }, null, id);
            }
            case 'applySuggestions': {
                if (!Array.isArray(action.suggestions) || action.suggestions.length > NATIVE_HOST_MAX_WINDOW || !action.suggestions.every(isSuggestion)) {
                    return fail('INVALID_INPUT', 'Suggestions with an id, action and reason are required');
                }
                // Only suggestions for items the review offers, as mobile applies them; a task
                // already where the suggestion puts it is not written again.
                const { weekStart } = getWeeklyReviewSettings(store.settings);
                const { staleItems } = getWeeklyReviewBuckets(store.tasks, store.projects, { weekStart });
                const suggestions = filterReviewSuggestions(action.suggestions, staleItems).filter((suggestion) => (
                    isActionableReviewSuggestion(suggestion)
                    && liveTask(suggestion.id)?.status !== (suggestion.action === 'someday' ? 'someday' : 'archived')
                ));
                const updates = buildReviewSuggestionUpdates(suggestions, new Set(suggestions.map((entry) => entry.id)), new Date());
                if (updates.length === 0) return unchanged();
                return written(() => store.batchUpdateTasks(updates));
            }
            case 'followUpToday': {
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                const plan = planDailyReviewFollowUp(task, getReviewDay(new Date()));
                if (!plan) return unchanged();
                return written(() => store.updateTask(task.id, plan));
            }
            default:
                return fail('INVALID_INPUT', 'Review does not offer that action');
        }
    };

    return {
        /**
         * The Review screen: areas, their projects and tasks, as far as they are
         * expanded. Send the returned expanded ids back with an `expansionEdit`;
         * `selectedIds` shows the bulk bar.
         */
        getReviewOverview(input: {
            expandedAreaIds?: string[];
            expandedProjectIds?: string[];
            expansionEdit?: NativeReviewExpansionEdit;
            selectedIds?: string[];
            /** Omitted for the previous whole-system overview; opt in to 'due' for reminders. */
            scope?: ReviewOverviewScope;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeReviewOverview> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'An offset and bounded limit are required');
            return reviewOverview(input);
        },

        /** The Weekly Review at `checkpoint` (null: this week's stored one is gone, start over). */
        getWeeklyReview(input: {
            checkpoint?: string | null;
            calendar?: NativeReviewCalendar;
            expandedProjectId?: string | null;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeWeeklyReview> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'An offset and bounded limit are required');
            return weeklyReview(input);
        },

        /**
         * A later window of one of the Weekly Review's nested lists: the stale step's
         * 'staleProjects' and 'aiItems', a calendar day's 'dayEvents' (key: the day's
         * key) or a context's 'contextTasks' (key: the context). Send the view's own
         * inputs and its revision.
         */
        getWeeklyReviewList(input: {
            checkpoint?: string | null;
            calendar?: NativeReviewCalendar;
            expandedProjectId?: string | null;
            list: NativeWeeklyReviewList;
            key?: string;
            offset: number;
            limit: number;
            revision: string;
        }): NativeHostResult<{ version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string; list: NativeWeeklyReviewList; key: string | null; total: number; items: unknown[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const valid = isObjectRecord(input) && typeof input.revision === 'string' && isPaging(input)
                && ['staleProjects', 'aiItems', 'dayEvents', 'contextTasks'].includes(input.list as string)
                && (input.key === undefined || isText(input.key));
            const read = valid ? readWeekly(input) : null;
            if (!read) return fail('INVALID_INPUT', 'The view\'s inputs, one of its lists, a valid window and its revision are required');
            if (read.revision !== input.revision) return fail('STALE_REVISION', 'The review changed; read it again');
            const key = input.list === 'dayEvents' || input.list === 'contextTasks' ? `${input.list}:${input.key ?? ''}` : input.list;
            const items = read.view.lists.get(key);
            if (!items) return fail('INVALID_INPUT', 'This step does not show that list');
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: read.revision,
                    list: input.list,
                    key: input.key ?? null,
                    total: items.length,
                    items: page(items, input),
                },
            };
        },

        /** The Daily Review at `checkpoint` (null: today's stored one is gone, start over). */
        getDailyReview(input: {
            checkpoint?: string | null;
            calendar?: NativeReviewCalendar;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeDailyReview> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'An offset and bounded limit are required');
            return dailyReview(input);
        },

        /**
         * One Review, Weekly Review or Daily Review action, as the screens write it.
         * Reuse `requestId` to retry: a completed request writes nothing again. The
         * Daily Review's focus star is setTaskFocus.
         */
        async runReviewAction(input: { requestId: string; action: NativeReviewAction }): Promise<NativeHostResult<NativeReviewActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action)) return fail('INVALID_INPUT', 'A request UUID and an action are required');
            const action = input.action as NativeReviewAction;
            return receipts.run(input.requestId, JSON.stringify(['review', action]), () => perform(input.requestId, action));
        },
    };
}
