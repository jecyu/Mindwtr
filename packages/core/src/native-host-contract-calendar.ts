/**
 * The native host contract for the Calendar screen: the month, week, day and
 * schedule views, their navigation, the task composer, and every action the
 * React Native screen offers on a calendar item. Kept in its own file and spread
 * into createNativeHostContract. Every view is built from core's calendar view
 * model (calendar-view-model.ts), the same functions the React Native screen
 * calls.
 *
 * The host keeps the screen's place as a `state` (mode, selected day, visible
 * month) and sends it back; every navigation control carries the state it leads
 * to. External calendars are platform I/O: the host fetches the view's `range`
 * and sends what it has as `calendar` (loading, ready or error).
 *
 * Reads are windowed by NATIVE_HOST_MAX_WINDOW under one revision. Writes go
 * through runCalendarAction with a request UUID: a request the receipts hold
 * (running, or owing its save) goes to them before any other check, and a retry
 * only saves (native-request-receipts.ts); every write is target-state, so a
 * replay after a restart writes nothing, and a task a request made answers its
 * replay only while it is exactly what the request writes. Success means the
 * change is saved. A refusal the screen shows (a time conflict, a composer
 * error) writes nothing and leaves the request ID free.
 *
 * Headings (month and week titles, day titles, weekday labels) come from
 * date-fns patterns through the user's date formatter: the host's engine has no
 * Intl. Their English text equals the React Native screen's.
 *
 * Only functions read this module's imports from native-host-contract.ts, so
 * the import cycle between the two files is safe.
 */
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import { formatCalendarTimeInputValue } from './calendar-scheduling';
import {
    applyComposerCreatedProject,
    openComposerAt,
    openComposerForDate,
    prepareComposerSave,
    selectComposerTask,
    setComposerDuration,
    setComposerEndTime,
    setComposerMode,
    setComposerQuery,
    setComposerTitle,
    type CalendarComposerDeps,
    type CalendarComposerError,
    type CalendarComposerMode,
    type CalendarComposerSaveContext,
} from './calendar-composer';
import type { CalendarDayItem, CalendarTimedLayout } from './calendar-day-items';
import { CALENDAR_TIME_ESTIMATE_OPTIONS, timeEstimateToMinutes } from './calendar-scheduling';
import {
    CALENDAR_DONE_UPDATES,
    CALENDAR_UNSCHEDULE_UPDATES,
    CALENDAR_VIEW_MODES,
    CALENDAR_WEEK_DENSITY_VALUES,
    calendarDateKey,
    coerceCalendarViewMode,
    coerceCalendarWeekVisibleDays,
    createCalendarSourceColorResolver,
    findCalendarFreeSlot,
    formatCalendarDurationChip,
    formatCalendarComposerClockValue,
    formatCalendarMonthTitle,
    formatCalendarScheduleDayTitle,
    formatCalendarSelectedDateLabels,
    formatCalendarWeekTitle,
    getCalendarComposerCandidates,
    getCalendarComposerErrorText,
    getCalendarComposerPlaceholders,
    getCalendarComposerText,
    getCalendarDayAllDayTones,
    isCalendarAllDayItem,
    getCalendarDayBounds,
    getCalendarDayItems,
    getCalendarDayLists,
    getCalendarDetailsTaskLists,
    getCalendarDayNames,
    getCalendarDayTimeline,
    getCalendarDetailsEventRow,
    getCalendarDetailsTaskRow,
    getCalendarEventSheet,
    getCalendarHourLabels,
    getCalendarItemTitle,
    createCalendarPatternDates,
    getCalendarModeOptions,
    getCalendarMonthCell,
    getCalendarMovedStart,
    getCalendarWallMinutes,
    getCalendarMonthDates,
    getCalendarMonthGrid,
    getCalendarMonthPreviewTones,
    getCalendarNavigationLabels,
    getCalendarNowMinutes,
    getCalendarPlanningTasks,
    getCalendarProjectedLabel,
    getCalendarRangeTasks,
    getCalendarScheduleActionLabel,
    getCalendarScheduleItemText,
    getCalendarScheduleItemTones,
    getCalendarScheduleSections,
    getCalendarSchedulableTasks,
    getCalendarScreenText,
    getCalendarSearchResults,
    getCalendarSourceNames,
    getCalendarSystem,
    getCalendarTaskSheet,
    getCalendarToasts,
    getCalendarVisibleRange,
    getCalendarWeekAllDayItems,
    getCalendarWeekAllDayTones,
    getCalendarWeekDays,
    getCalendarWeekStart,
    getCalendarWeekTimedEntries,
    getCalendarWeekdayLabel,
    indexCalendarCompletedTasks,
    indexCalendarDeadlineTasks,
    indexCalendarEvents,
    indexCalendarScheduledTasks,
    isCalendarComposerSaveDisabled,
    isCalendarSlotFree,
    isSameCalendarDate,
    moveCalendarPeriod,
    needsCalendarSelectedDate,
    planCalendarEventTask,
    planCalendarTaskMove,
    selectCalendarViewMode,
    setCalendarViewComposerStartTime,
    toCalendarViewComposer,
    type CalendarPeriodState,
    type CalendarSheetButton,
    type CalendarTone,
    type CalendarToast,
    type CalendarViewComposerState,
    type CalendarViewMode,
} from './calendar-view-model';
import { createDateFormatter, getCalendarDayOfMonth, getWeekStartsOnIndex, safeParseDate, startOfCalendarMonth, type DateFormatter, type DateFormattingConfig } from './date';
import type { ExternalCalendarEvent, ExternalCalendarSubscription } from './ics';
import { formatLocalDate } from './import-source-reader';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, type NativeUnsavedWrite } from './native-request-receipts';
import { buildQuickAddParseOptions } from './quick-add';
import { isProjectedRecurringTaskId } from './recurrence';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { useTaskStore } from './store';
import { themeDescriptor } from './theme-scheme';
import type { Task } from './types';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];
type Translate = (key: string) => string;

export type CalendarViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => Translate;
    /** The user's date settings; clock times format through createDateFormatter with them. */
    dateFormatting: () => DateFormattingConfig;
    /** Data and settings revision, without the clock: what the period index reads. */
    dataRevision: () => string;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

/**
 * The external calendars as the host fetched them for the view's `range`.
 * While a refetch runs, send the calendars and events already shown with
 * `loading`; after a failure the screen keeps the calendars and shows no events.
 * Absent: no calendar fetched.
 */
export type NativeCalendarFeed =
    | { status: 'loading'; calendars?: ExternalCalendarSubscription[]; events?: ExternalCalendarEvent[] }
    | { status: 'error'; message: string; calendars?: ExternalCalendarSubscription[] }
    | { status: 'ready'; calendars: ExternalCalendarSubscription[]; events: ExternalCalendarEvent[] };

/** The screen's place: its mode, the selected day (null: none, month view only) and a day of the visible month. Days are `yyyy-MM-dd`. */
export type NativeCalendarState = { viewMode: CalendarViewMode; selectedDate: string | null; visibleMonth: string };

export type NativeCalendarItem = {
    /** The React Native item id ("scheduled-<task>", "deadline-<task>", "completed-<task>", "event-<event>"), or the task or event id in a list. */
    id: string;
    kind: 'scheduled' | 'deadline' | 'completed' | 'event';
    taskId: string | null;
    eventId: string | null;
    /** The title as drawn: a projected occurrence adds "· Projected · Oct 31" where the screen does. */
    title: string;
    /** The second line (a time, "All day", "Deadline"), or null where the surface draws none. */
    detail: string | null;
    accessibilityLabel: string | null;
    projected: boolean;
    /** Pressing opens getCalendarItemSheet. False for completed or projected items where the screen disables it. */
    pressable: boolean;
    /** Theme tones: `fill` behind the item, `accent` on its left edge, `text` its title; `source` means `sourceColor`. */
    tones: { fill: CalendarTone | null; accent: CalendarTone | null; text: CalendarTone | null; dashed: boolean; struck: boolean; faded: boolean };
    /** The event's calendar color, as the screen resolves it. */
    sourceColor: string | null;
    /**
     * A timed block: minutes into the day (clamped to it), its column among
     * overlapping blocks, and a task's own duration (what a drag moves).
     */
    timed: { startMinutes: number; endMinutes: number; durationMinutes: number; column: CalendarTimedLayout | null } | null;
    /** The row offers Done (month details). */
    showDone: boolean;
    row: NativeTaskRow | null;
};

export type NativeCalendarEntry =
    /** A month cell with its preview items, a week column header, or a schedule day heading. */
    | {
        type: 'day';
        key: string;
        title: string;
        dayNumber: string;
        weekday: string;
        isToday: boolean;
        selected: boolean;
        accessibilityLabel: string | null;
        /** Month cells that hide items show their task and event counts. */
        counts: { tasks: number; events: number } | null;
        preview: NativeCalendarItem[];
        /** Pressing a week column header opens this day in the day view. */
        opens: NativeCalendarState | null;
    }
    /** An item in a lane of a day: the week's all-day lane or timeline, the day view's, a schedule day, or the month details' lists. */
    | { type: 'item'; dayKey: string; lane: 'allDay' | 'timed' | 'list' | 'events' | 'deadlines' | 'scheduled'; item: NativeCalendarItem }
    /** A task to schedule: a search result under the selected day, or a planning suggestion. Press it with openCalendarComposer({ scheduleTaskId }). */
    | { type: 'task'; list: 'search' | 'planning'; taskId: string; title: string; detail: string; row: NativeTaskRow };

type NavigationTarget = { label: string; state: NativeCalendarState };

export type NativeCalendarView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The state this view shows; keep it and send it back. */
    state: NativeCalendarState;
    /** Fetch external events for this window and send them as `calendar`. */
    range: { start: string; end: string };
    header: {
        title: string;
        /** The day view uses the day title style. */
        titleVariant: 'day' | 'standard';
        previous: NavigationTarget | null;
        next: NavigationTarget | null;
        today: NavigationTarget;
    };
    /** The mode switch; choosing one also runs setViewMode, which the screen saves. */
    modes: { mode: CalendarViewMode; label: string; selected: boolean; state: NativeCalendarState }[];
    showCompleted: { label: string; hint: string; on: boolean };
    text: Omit<ReturnType<typeof getCalendarScreenText>, 'weekDensityValue' | 'weekDensityChoice'> & { toasts: NativeCalendarToasts };
    content:
        | {
            mode: 'month';
            dayNames: string[];
            /** Blank cells before the month's first day. */
            leadingBlanks: number;
            /** The selected day's details panel; `close` is the state without it. */
            details: {
                title: string;
                close: NativeCalendarState;
                query: string;
                searchTitle: string | null;
                /** Null when no external calendar is configured. */
                events: { title: string; loading: string | null; error: string | null } | null;
                empty: string | null;
            } | null;
        }
        | {
            mode: 'week';
            visibleDays: number;
            density: { value: string; choices: { days: number; label: string; selected: boolean }[] };
            hourLabels: string[];
            /** Minutes into today for the current-time line; the column of today draws it. */
            nowMinutes: number | null;
        }
        | {
            mode: 'day';
            dayKey: string;
            hourLabels: string[];
            nowMinutes: number | null;
            query: string;
            searchTitle: string | null;
        }
        | {
            mode: 'schedule';
            planning: { title: string; subtitle: string } | null;
            empty: string | null;
        };
    total: number;
    items: NativeCalendarEntry[];
};

export type NativeCalendarToasts = Omit<ReturnType<typeof getCalendarToasts>, 'saveFailed'> & { saveFailed: CalendarToast };

/** The composer as the host holds it: send it back with every edit and to save. Instants are ISO. */
export type NativeCalendarComposer = {
    date: string;
    startTimeValue: string;
    startAt: string | null;
    endTimeValue: string;
    durationMinutes: number;
    mode: CalendarComposerMode;
    title: string;
    query: string;
    selectedTaskId: string | null;
    error: CalendarComposerError | null;
};

export type NativeCalendarComposerView = {
    composer: NativeCalendarComposer;
    timeLabels: { start: string; end: string };
    text: ReturnType<typeof getCalendarComposerText>;
    dateLabel: string;
    placeholders: { start: string; end: string };
    durations: { minutes: number; label: string; selected: boolean }[];
    /** The existing-task list (existing mode only). */
    candidates: { id: string; title: string; selected: boolean }[] | null;
    selectedTaskTitle: string | null;
    error: string | null;
    saveDisabled: boolean;
};

export type NativeCalendarComposerEdit =
    | { type: 'mode'; mode: CalendarComposerMode }
    | { type: 'title'; title: string }
    | { type: 'query'; query: string }
    | { type: 'selectTask'; taskId: string }
    | { type: 'startTime'; value: string }
    | { type: 'endTime'; value: string }
    | { type: 'duration'; minutes: number };

export type NativeCalendarSheet =
    | { kind: 'projected'; title: string; message: string; buttons: CalendarSheetButton<'ok'>[] }
    | { kind: 'task'; taskId: string; title: string; buttons: CalendarSheetButton<'edit' | 'unschedule' | 'done' | 'delete' | 'cancel'>[] }
    | { kind: 'event'; title: string; buttons: CalendarSheetButton<'createTask' | 'openInCalendar' | 'cancel'>[] };

export type NativeCalendarAction =
    /** The composer's Save. A new task takes the request ID as its id. */
    | { type: 'saveComposer'; composer: NativeCalendarComposer }
    /** A timeline block let go at `startMinutes` into `day`. */
    | { type: 'moveTask'; taskId: string; day: string; startMinutes: number; durationMinutes: number }
    | { type: 'unscheduleTask'; taskId: string }
    | { type: 'completeTask'; taskId: string }
    | { type: 'deleteTask'; taskId: string }
    /** An event's Create task. The request ID becomes the task id. */
    | { type: 'createTaskFromEvent'; event: ExternalCalendarEvent }
    | { type: 'setViewMode'; viewMode: CalendarViewMode }
    | { type: 'setShowCompleted'; on: boolean }
    | { type: 'setWeekVisibleDays'; days: number };

export type NativeCalendarActionResult = {
    /** False when the action had nothing to write, or was refused (see `toast` and `composer`). */
    changed: boolean;
    toast: CalendarToast | null;
    /** The state to show after it: the day view on a saved composer's start, an event task's day. */
    next: NativeCalendarState | null;
    /** The day view scrolls its timeline to this minute. */
    scrollToMinutes: number | null;
    /** A refused composer save: the composer with its error. */
    composer: NativeCalendarComposerView | null;
    /** The task a composer save or an event wrote. */
    taskId: string | null;
};

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const isPaging = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
    && (input.revision === undefined || typeof input.revision === 'string')
    && ((input.offset as number) === 0 || typeof input.revision === 'string')
);
/** A short, stable key for a view's own inputs, so a page of one view never continues another. */
const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENTERED_LIMIT = 200;
const MAX_EVENTS = 2000;
const MAX_CALENDARS = 200;
const ISO_INSTANT_LIMIT = 64;

/** A `yyyy-MM-dd` day as local midnight, or null. */
const parseDayKey = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return formatLocalDate(date) === value ? date : null;
};
const dayKey = (date: Date): string => formatLocalDate(date);
const toState = (period: CalendarPeriodState): NativeCalendarState => ({
    viewMode: period.viewMode,
    selectedDate: period.selectedDate ? dayKey(period.selectedDate) : null,
    visibleMonth: dayKey(period.visibleMonthDate),
});

const isEvent = (value: unknown): value is ExternalCalendarEvent => (
    isObjectRecord(value) && isText(value.id) && isText(value.sourceId) && isText(value.title, 2000)
    && isText(value.start, ISO_INSTANT_LIMIT) && isText(value.end, ISO_INSTANT_LIMIT) && typeof value.allDay === 'boolean'
    && (value.nativeEventId === undefined || isText(value.nativeEventId))
    && (value.description === undefined || isText(value.description, 20_000))
    && (value.location === undefined || isText(value.location, 2000))
);
const isCalendarSource = (value: unknown): value is ExternalCalendarSubscription => (
    isObjectRecord(value) && isText(value.id) && isText(value.name, 2000)
    && (value.color === undefined || isText(value.color, 64)) && (value.feedColor === undefined || isText(value.feedColor, 64))
);
const isList = <T,>(value: unknown, limit: number, check: (entry: unknown) => entry is T): value is T[] => (
    Array.isArray(value) && value.length <= limit && value.every(check)
);

type Feed = { calendars: ExternalCalendarSubscription[]; events: ExternalCalendarEvent[]; loading: boolean; error: string | null };
const readFeed = (value: unknown): Feed | null => {
    if (value === undefined) return { calendars: [], events: [], loading: false, error: null };
    if (!isObjectRecord(value)) return null;
    const calendars = value.calendars === undefined ? [] : value.calendars;
    if (!isList(calendars, MAX_CALENDARS, isCalendarSource)) return null;
    if (value.status === 'loading') {
        const events = value.events === undefined ? [] : value.events;
        return isList(events, MAX_EVENTS, isEvent) ? { calendars, events: [], loading: true, error: null } : null;
    }
    if (value.status === 'error' && isText(value.message, 2000)) return { calendars, events: [], loading: false, error: value.message };
    if (value.status === 'ready' && isList(value.events, MAX_EVENTS, isEvent)) return { calendars, events: value.events, loading: false, error: null };
    return null;
};

const toComposer = (state: CalendarViewComposerState): NativeCalendarComposer => ({
    date: state.date.toISOString(),
    startTimeValue: state.startTimeValue,
    startAt: state.startAt ? state.startAt.toISOString() : null,
    endTimeValue: state.endTimeValue,
    durationMinutes: state.durationMinutes,
    mode: state.mode,
    title: state.title,
    query: state.query,
    selectedTaskId: state.selectedTaskId,
    error: state.error,
});
const COMPOSER_ERROR_CODES = new Set(['invalid_range', 'title_required', 'task_required', 'overlap', 'invalid_date_command', 'start_after_due', 'save_failed']);
const readComposer = (value: unknown, formatDate: DateFormatter): CalendarViewComposerState | null => {
    if (!isObjectRecord(value)) return null;
    const date = isText(value.date, ISO_INSTANT_LIMIT) ? safeParseDate(value.date) : null;
    const startAt = value.startAt === null ? null : isText(value.startAt, ISO_INSTANT_LIMIT) ? safeParseDate(value.startAt) : undefined;
    const error = value.error;
    const validError = error === null || (isObjectRecord(error) && COMPOSER_ERROR_CODES.has(error.code as string)
        && (error.detail === undefined || isText(error.detail, 2000)));
    if (!date || startAt === undefined || !validError
        || !isText(value.startTimeValue, 64) || !isText(value.endTimeValue, 64)
        || !Number.isSafeInteger(value.durationMinutes) || (value.durationMinutes as number) < 1 || (value.durationMinutes as number) > 24 * 60
        || (value.mode !== 'new' && value.mode !== 'existing')
        || !isText(value.title, 10_000) || !isText(value.query, 2000)
        || (value.selectedTaskId !== null && !isText(value.selectedTaskId))) {
        return null;
    }
    const rawStart = startAt ? formatCalendarTimeInputValue(startAt) : null;
    const end = startAt ? new Date(startAt.getTime() + (value.durationMinutes as number) * 60_000) : null;
    const rawEnd = end ? formatCalendarTimeInputValue(end) : null;
    return {
        date,
        startTimeValue: rawStart && value.startTimeValue === formatDate(startAt, 'p', rawStart) ? rawStart : value.startTimeValue,
        startAt,
        endTimeValue: rawEnd && value.endTimeValue === formatDate(end, 'p', rawEnd) ? rawEnd : value.endTimeValue,
        durationMinutes: value.durationMinutes as number,
        mode: value.mode,
        title: value.title,
        query: value.query,
        selectedTaskId: value.selectedTaskId as string | null,
        error: error as CalendarComposerError | null,
    };
};

export function createCalendarViewMethods(deps: CalendarViewDeps) {
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
    // Recurring projections are anchored once per local day, as on mobile, so a
    // fluid series does not move with every minute of the revision.
    let projectedAt = { day: '', iso: '' };
    // ponytail: one cached view per revision and inputs; paging rebuilds nothing.
    let cachedView: { key: string; value: BuiltView } | null = null;
    // Request IDs that entered the receipts, and their payloads, so a retry reaches its
    // receipt before any check. ponytail: the last 200; the receipts keep 50 anyway.
    const entered = new Map<string, string>();

    /** The tasks the screen may show (mobile's visible-task projection), per data and settings revision. */
    let visible: { key: string; value: ReturnType<typeof buildVisible> } | null = null;
    const buildVisible = () => {
        const store = useTaskStore.getState();
        const areas = sortAreasForDisplay(store.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(store.projects.map((project) => [project.id, project]));
        const resolvedAreaFilter = resolveAreaFilterSelection(store.settings.filters, areas);
        const visibleTasks = store.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
        return { areaById, projectById, resolvedAreaFilter, visibleTasks, schedulableTasks: getCalendarSchedulableTasks(visibleTasks) };
    };
    const visibleFor = (dataRevision: string) => {
        if (visible?.key !== dataRevision) visible = { key: dataRevision, value: buildVisible() };
        return visible.value;
    };

    /** Everything a view, the composer and the actions read, as mobile's screen reads it. */
    const context = (now: Date) => {
        const store = useTaskStore.getState();
        const settings = store.settings;
        const config = deps.dateFormatting();
        const language = config.language ?? 'en';
        const systemLocale = config.systemLocale ?? '';
        const dataRevision = deps.dataRevision();
        const flags = resolveFeatureFlags(settings);
        const t = deps.t();
        const formatDate = createDateFormatter(config) as DateFormatter;
        anchorProjections(now);
        return {
            store,
            settings,
            t,
            now,
            dataRevision,
            // No Intl on the native host: headings come from date-fns patterns.
            dates: createCalendarPatternDates(createDateFormatter(config, { jalaliMonthNames: true })),
            calendarSystem: getCalendarSystem({ language, settings, systemLocale }),
            formatDate,
            weekStartIndex: getWeekStartsOnIndex(settings.weekStart),
            flags,
            ...visibleFor(dataRevision),
            estimateMinutes: (estimate: Task['timeEstimate']) => timeEstimateToMinutes(estimate, { enabled: flags.timeEstimates }),
            projectedLabel: getCalendarProjectedLabel(t),
            showCompleted: settings.calendar?.showCompleted === true,
        };
    };
    type Context = ReturnType<typeof context>;
    const anchorProjections = (now: Date) => {
        const today = dayKey(now);
        if (projectedAt.day !== today) projectedAt = { day: today, iso: now.toISOString() };
    };

    /** The state the host sent, or the screen's opening state; a mode that needs a day gets today. */
    const readState = (value: unknown, ctx: Pick<Context, 'settings' | 'now'>): CalendarPeriodState | null => {
        const today = parseDayKey(dayKey(ctx.now))!;
        if (value === undefined) {
            const viewMode = coerceCalendarViewMode(ctx.settings.calendar?.viewMode);
            return { viewMode, selectedDate: needsCalendarSelectedDate(viewMode) ? today : null, visibleMonthDate: today };
        }
        if (!isObjectRecord(value) || !CALENDAR_VIEW_MODES.includes(value.viewMode as CalendarViewMode)) return null;
        const selectedDate = value.selectedDate === null ? null : parseDayKey(value.selectedDate);
        const visibleMonthDate = parseDayKey(value.visibleMonth);
        if (!visibleMonthDate || (value.selectedDate !== null && !selectedDate)) return null;
        return selectCalendarViewMode({ viewMode: 'month', selectedDate, visibleMonthDate }, value.viewMode as CalendarViewMode, today);
    };

    /**
     * The period's tasks and events by day. Cached by what it reads (the data and
     * settings revision, the range, the events and the projection day), so a new
     * selected day, search text or item sheet in the same range expands nothing.
     */
    // ponytail: the last two ranges; a host that flips between more ranges rebuilds.
    const indexCache: { key: string; value: ReturnType<typeof buildIndex> }[] = [];
    const buildIndex = (ctx: Context, range: { rangeStart: Date; rangeEnd: Date }, feed: Feed) => {
        const rangeTasks = getCalendarRangeTasks(
            ctx.visibleTasks,
            { rangeStartMs: range.rangeStart.getTime(), rangeEndMs: range.rangeEnd.getTime() },
            projectedAt.iso,
        );
        const index = {
            scheduled: indexCalendarScheduledTasks(rangeTasks),
            deadlines: indexCalendarDeadlineTasks(rangeTasks),
            completed: indexCalendarCompletedTasks(ctx.store._allTasks, {
                showCompleted: ctx.showCompleted, projectById: ctx.projectById, areaById: ctx.areaById, resolvedAreaFilter: ctx.resolvedAreaFilter,
            }),
            events: indexCalendarEvents(feed.events),
        };
        return { rangeTasks, index, lists: (date: Date) => getCalendarDayLists(index, date) };
    };
    const periodIndex = (ctx: Context, period: CalendarPeriodState, feed: Feed) => {
        const currentMonthDate = startOfCalendarMonth(period.visibleMonthDate, ctx.calendarSystem);
        const weekStartTime = getCalendarWeekStart(period.selectedDate ?? currentMonthDate, ctx.weekStartIndex).getTime();
        const range = getCalendarVisibleRange({
            calendarSystem: ctx.calendarSystem, currentMonthDate, selectedDate: period.selectedDate, viewMode: period.viewMode, weekStartTime,
        });
        const key = [ctx.dataRevision, range.rangeStart.getTime(), range.rangeEnd.getTime(), paramsKey(feed.events), projectedAt.iso].join('|');
        let hit = indexCache.find((entry) => entry.key === key);
        if (!hit) {
            hit = { key, value: buildIndex(ctx, range, feed) };
            indexCache.unshift(hit);
            indexCache.length = Math.min(indexCache.length, 2);
        }
        return { currentMonthDate, weekStartTime, range, ...hit.value };
    };

    const slotOptions = (ctx: Context, events: readonly ExternalCalendarEvent[], excludeTaskId?: string) => ({
        events, excludeTaskId, tasks: ctx.schedulableTasks, timeEstimatesEnabled: ctx.flags.timeEstimates, now: ctx.now,
    });

    type BuiltView = Omit<NativeCalendarView, 'version' | 'revision' | 'total' | 'items'> & { entries: PendingEntry[] };
    type PendingItem = Omit<NativeCalendarItem, 'row'> & { task: Task | null };
    type PendingEntry =
        | (Omit<Extract<NativeCalendarEntry, { type: 'day' }>, 'preview'> & { preview: PendingItem[] })
        | { type: 'item'; dayKey: string; lane: Extract<NativeCalendarEntry, { type: 'item' }>['lane']; item: PendingItem }
        | { type: 'task'; list: 'search' | 'planning'; taskId: string; title: string; detail: string; task: Task };

    const item = (source: CalendarDayItem | null, fields: Partial<PendingItem> & Pick<PendingItem, 'title'>, task: Task | null, event: ExternalCalendarEvent | null): PendingItem => ({
        id: source?.id ?? task?.id ?? event?.id ?? '',
        kind: source?.kind ?? (event ? 'event' : 'scheduled'),
        taskId: task?.id ?? null,
        eventId: event?.id ?? null,
        detail: null,
        accessibilityLabel: null,
        projected: false,
        pressable: true,
        tones: { fill: null, accent: null, text: null, dashed: false, struck: false, faded: false },
        sourceColor: null,
        timed: null,
        showDone: false,
        ...fields,
        task,
    });
    const sourceTask = (entry: CalendarDayItem): Task | null => (entry.kind === 'event' ? null : entry.task);
    const sourceEvent = (entry: CalendarDayItem): ExternalCalendarEvent | null => (entry.kind === 'event' ? entry.event : null);
    const minutesIn = (dayStart: Date, from: Date, to: Date, layout: CalendarTimedLayout | undefined, durationMinutes?: number) => {
        const startMinutes = getCalendarWallMinutes(dayStart, from);
        const endMinutes = getCalendarWallMinutes(dayStart, to);
        return { startMinutes, endMinutes, durationMinutes: durationMinutes ?? endMinutes - startMinutes, column: layout ?? null };
    };

    const build = (ctx: Context, period: CalendarPeriodState, feed: Feed, query: string): BuiltView => {
        const { t, formatDate, dates, now, projectedLabel } = ctx;
        const periodData = periodIndex(ctx, period, feed);
        const { lists, currentMonthDate, weekStartTime } = periodData;
        // Calendar colors in the theme's variant, as mobile paints them (its theme preset).
        const sourceColor = createCalendarSourceColorResolver(feed.calendars, themeDescriptor(ctx.settings.theme)?.statusPreset ?? 'default');
        const sourceNames = getCalendarSourceNames(feed.calendars);
        const screen = getCalendarScreenText(t);
        const toasts = getCalendarToasts(t);
        const nav = getCalendarNavigationLabels(period.viewMode, t);
        const move = (direction: 'previous' | 'next' | 'today'): NativeCalendarState => (
            toState(moveCalendarPeriod(period, direction, { calendarSystem: ctx.calendarSystem, now: parseDayKey(dayKey(now))! }))
        );
        const selected = period.selectedDate;
        const dateLabels = formatCalendarSelectedDateLabels(selected, { dates, t, now });
        const entries: PendingEntry[] = [];
        const eventsFor = (date: Date) => lists(date).events;

        const scheduleRow = (task: Task, list: 'search' | 'planning'): PendingEntry => {
            const durationMinutes = ctx.estimateMinutes(task.timeEstimate);
            const slot = selected ? findCalendarFreeSlot(selected, durationMinutes, slotOptions(ctx, eventsFor(selected), task.id)) : null;
            return { type: 'task', list, taskId: task.id, title: task.title, detail: getCalendarScheduleActionLabel(slot, durationMinutes, { t, formatDate }), task };
        };
        const searchResults = selected ? getCalendarSearchResults(ctx.schedulableTasks, query) : [];

        let content: NativeCalendarView['content'];
        let title: string;
        if (period.viewMode === 'month') {
            title = formatCalendarMonthTitle(currentMonthDate, dates);
            const grid = getCalendarMonthGrid(currentMonthDate, getCalendarMonthDates(currentMonthDate, ctx.calendarSystem), ctx.weekStartIndex);
            for (const date of grid) {
                if (!date) continue;
                const cell = getCalendarMonthCell(date, lists(date), { dates, t });
                entries.push({
                    type: 'day',
                    key: dayKey(date),
                    title: String(getCalendarDayOfMonth(date, ctx.calendarSystem)),
                    dayNumber: String(getCalendarDayOfMonth(date, ctx.calendarSystem)),
                    weekday: getCalendarWeekdayLabel(date, dates),
                    isToday: isSameCalendarDate(date, now),
                    selected: Boolean(selected && isSameCalendarDate(date, selected)),
                    accessibilityLabel: cell.accessibilityLabel,
                    counts: cell.showCounts ? { tasks: cell.taskCount, events: cell.eventCount } : null,
                    preview: cell.previewItems.map((entry) => {
                        const tones = getCalendarMonthPreviewTones(entry);
                        const event = sourceEvent(entry);
                        return item(entry, {
                            title: getCalendarItemTitle(entry, projectedLabel, formatDate),
                            projected: tones.dashed,
                            pressable: false,
                            tones: { fill: tones.fill, accent: tones.accent, text: tones.text, dashed: tones.dashed, struck: tones.struck, faded: false },
                            sourceColor: event ? sourceColor(event.sourceId) : null,
                        }, sourceTask(entry), event);
                    }),
                    opens: null,
                });
            }
            let details: Extract<NativeCalendarView['content'], { mode: 'month' }>['details'] = null;
            if (selected) {
                const day = dayKey(selected);
                const dayLists = lists(selected);
                for (const task of searchResults) entries.push(scheduleRow(task, 'search'));
                const showEvents = feed.calendars.length > 0 || feed.error !== null;
                if (showEvents) {
                    for (const event of dayLists.events) {
                        const row = getCalendarDetailsEventRow(event, { t, formatDate, sourceNames });
                        entries.push({ type: 'item', dayKey: day, lane: 'events', item: item(null, {
                            id: event.id, kind: 'event', title: row.title, detail: row.detail,
                            tones: { fill: 'input', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                            sourceColor: sourceColor(event.sourceId),
                        }, null, event) });
                    }
                }
                const detailTasks = getCalendarDetailsTaskLists(dayLists);
                for (const kind of ['deadline', 'scheduled'] as const) {
                    for (const task of detailTasks[kind === 'deadline' ? 'deadlines' : 'scheduled']) {
                        const row = getCalendarDetailsTaskRow(task, kind, { t, formatDate, projectedLabel, timeEstimateToMinutes: ctx.estimateMinutes });
                        entries.push({ type: 'item', dayKey: day, lane: kind === 'deadline' ? 'deadlines' : 'scheduled', item: item(null, {
                            id: task.id, kind, title: task.title, detail: row.detail, projected: row.projected, pressable: !row.projected,
                            tones: { fill: row.tones.fill, accent: 'tint', text: row.tones.title, dashed: row.tones.dashed, struck: false, faded: false },
                            showDone: row.showDone,
                        }, task, null) });
                    }
                }
                const empty = detailTasks.deadlines.length === 0 && detailTasks.scheduled.length === 0 && dayLists.events.length === 0;
                details = {
                    title: dateLabels.long,
                    close: toState({ ...period, selectedDate: null }),
                    query,
                    searchTitle: searchResults.length > 0 ? screen.searchResultsTitle : null,
                    events: showEvents ? { title: screen.events, loading: feed.loading ? screen.loading : null, error: feed.error } : null,
                    empty: empty ? screen.noTasks : null,
                };
            }
            content = {
                mode: 'month',
                dayNames: getCalendarDayNames(dates, ctx.weekStartIndex),
                leadingBlanks: grid.findIndex((date) => date !== null),
                details,
            };
        } else if (period.viewMode === 'week') {
            const weekDays = getCalendarWeekDays(weekStartTime);
            title = formatCalendarWeekTitle(weekDays, dates);
            for (const date of weekDays) {
                entries.push({
                    type: 'day', key: dayKey(date), title: `${getCalendarWeekdayLabel(date, dates)} ${date.getDate()}`,
                    dayNumber: String(date.getDate()), weekday: getCalendarWeekdayLabel(date, dates),
                    isToday: isSameCalendarDate(date, now), selected: Boolean(selected && isSameCalendarDate(date, selected)),
                    accessibilityLabel: null, counts: null, preview: [],
                    opens: toState(selectCalendarViewMode({ ...period, selectedDate: date }, 'day', now)),
                });
            }
            for (const date of weekDays) {
                for (const entry of getCalendarWeekAllDayItems(getCalendarDayItems(lists(date)))) {
                    const tones = getCalendarWeekAllDayTones(entry);
                    const event = sourceEvent(entry);
                    entries.push({ type: 'item', dayKey: dayKey(date), lane: 'allDay', item: item(entry, {
                        title: getCalendarItemTitle(entry, projectedLabel, formatDate), projected: tones.dashed, pressable: !tones.disabled,
                        tones: { fill: tones.fill, accent: tones.accent, text: 'text', dashed: tones.dashed, struck: false, faded: false },
                        sourceColor: event ? sourceColor(event.sourceId) : null,
                    }, sourceTask(entry), event) });
                }
            }
            for (const date of weekDays) {
                const { dayStart, dayEnd } = getCalendarDayBounds(date);
                for (const entry of getCalendarWeekTimedEntries({
                    items: getCalendarDayItems(lists(date)), dayStart, dayEnd, timeEstimateToMinutes: ctx.estimateMinutes, formatDate, projectedLabel,
                })) {
                    if (entry.kind === 'event') {
                        entries.push({ type: 'item', dayKey: dayKey(date), lane: 'timed', item: item(entry.item, {
                            title: entry.item.title, detail: entry.timeLabel,
                            tones: { fill: 'secondary', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                            sourceColor: sourceColor(entry.item.event.sourceId),
                            timed: minutesIn(dayStart, entry.start, entry.end, entry.layout),
                        }, null, entry.item.event) });
                    } else {
                        entries.push({ type: 'item', dayKey: dayKey(date), lane: 'timed', item: item(entry.item, {
                            title: entry.item.title, detail: entry.timeLabel, projected: entry.projected, pressable: !entry.projected,
                            tones: { fill: 'tint', accent: 'tint', text: entry.projected ? 'tint' : null, dashed: entry.projected, struck: false, faded: false },
                            timed: minutesIn(dayStart, entry.displayStart, entry.displayEnd, entry.layout, entry.durationMinutes),
                        }, entry.item.task, null) });
                    }
                }
            }
            const visibleDays = coerceCalendarWeekVisibleDays(ctx.settings.calendar?.weekVisibleDays);
            content = {
                mode: 'week',
                visibleDays,
                density: {
                    value: screen.weekDensityValue(visibleDays),
                    choices: CALENDAR_WEEK_DENSITY_VALUES.map((days) => ({ days, label: screen.weekDensityChoice(days), selected: days === visibleDays })),
                },
                hourLabels: getCalendarHourLabels(formatDate),
                nowMinutes: getCalendarNowMinutes(now),
            };
        } else if (period.viewMode === 'day') {
            const day = selected!;
            title = dateLabels.dayTitle;
            const dayLists = lists(day);
            for (const entry of getCalendarDayItems(dayLists).filter(isCalendarAllDayItem)) {
                const event = sourceEvent(entry);
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'allDay', item: item(entry, {
                    title: getCalendarItemTitle(entry, projectedLabel, formatDate),
                    projected: getCalendarDayAllDayTones(entry).text === 'tint', pressable: !getCalendarDayAllDayTones(entry).disabled,
                    tones: { fill: null, accent: null, text: getCalendarDayAllDayTones(entry).text, dashed: false, struck: false, faded: false },
                }, sourceTask(entry), event) });
            }
            const { dayStart, dayEnd } = getCalendarDayBounds(day);
            const timeline = getCalendarDayTimeline({
                events: dayLists.events, tasks: dayLists.scheduled, dayStart, dayEnd, timeEstimateToMinutes: ctx.estimateMinutes, formatDate, projectedLabel,
            });
            for (const entry of timeline.events) {
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'timed', item: item(null, {
                    id: entry.event.id, kind: 'event', title: entry.event.title, detail: entry.timeLabel,
                    tones: { fill: 'secondary', accent: 'source', text: 'text', dashed: false, struck: false, faded: false },
                    sourceColor: sourceColor(entry.event.sourceId),
                    timed: minutesIn(dayStart, entry.start, entry.end, entry.layout),
                }, null, entry.event) });
            }
            for (const entry of timeline.tasks) {
                entries.push({ type: 'item', dayKey: dayKey(day), lane: 'timed', item: item(null, {
                    id: entry.task.id, kind: 'scheduled', title: entry.task.title, detail: entry.timeLabel, projected: entry.projected,
                    tones: { fill: 'tint', accent: 'tint', text: entry.projected ? 'tint' : null, dashed: entry.projected, struck: false, faded: false },
                    timed: minutesIn(dayStart, entry.displayStart, entry.displayEnd, entry.layout, entry.durationMinutes),
                }, entry.task, null) });
            }
            for (const task of searchResults) entries.push(scheduleRow(task, 'search'));
            content = {
                mode: 'day',
                dayKey: dayKey(day),
                hourLabels: getCalendarHourLabels(formatDate),
                nowMinutes: isSameCalendarDate(day, now) ? getCalendarNowMinutes(now) : null,
                query,
                searchTitle: searchResults.length > 0 ? screen.searchResultsTitle : null,
            };
        } else {
            title = screen.scheduleTitle;
            const sections = getCalendarScheduleSections(selected ?? currentMonthDate, (date) => getCalendarDayItems(lists(date)));
            for (const section of sections) {
                const key = dayKey(section.date);
                entries.push({
                    type: 'day', key, title: formatCalendarScheduleDayTitle(section.date, { dates, t, now }),
                    dayNumber: String(section.date.getDate()), weekday: getCalendarWeekdayLabel(section.date, dates),
                    isToday: isSameCalendarDate(section.date, now), selected: false, accessibilityLabel: null, counts: null, preview: [], opens: null,
                });
                for (const entry of section.items) {
                    const text = getCalendarScheduleItemText(entry, { t, formatDate, projectedLabel, sourceNames, timeEstimateToMinutes: ctx.estimateMinutes });
                    const tones = getCalendarScheduleItemTones(entry);
                    const event = sourceEvent(entry);
                    entries.push({ type: 'item', dayKey: key, lane: 'list', item: item(entry, {
                        title: entry.title, detail: text.detail, accessibilityLabel: text.accessibilityLabel, projected: tones.dashed,
                        pressable: !tones.disabled,
                        tones: { fill: tones.fill, accent: tones.accent, text: tones.title, dashed: tones.dashed, struck: tones.struck, faded: tones.faded },
                        sourceColor: event ? sourceColor(event.sourceId) : null,
                    }, sourceTask(entry), event) });
                }
            }
            const planning = selected ? getCalendarPlanningTasks(ctx.visibleTasks, {
                now, prioritiesEnabled: ctx.flags.priorities, projects: ctx.store.projects, sections: ctx.store.sections,
            }) : [];
            for (const task of planning) entries.push(scheduleRow(task, 'planning'));
            content = {
                mode: 'schedule',
                planning: planning.length > 0 ? { title: screen.planningTitle, subtitle: dateLabels.planning } : null,
                empty: sections.length === 0 && planning.length === 0 ? screen.noTasks : null,
            };
        }

        const periodNav = period.viewMode === 'schedule' ? null : period.viewMode;
        const { weekDensityValue: _value, weekDensityChoice: _choice, ...fixedText } = screen;
        return {
            state: toState(period),
            range: { start: periodData.range.rangeStart.toISOString(), end: periodData.range.rangeEnd.toISOString() },
            header: {
                title,
                titleVariant: period.viewMode === 'day' ? 'day' : 'standard',
                previous: periodNav ? { label: nav.previous, state: move('previous') } : null,
                next: periodNav ? { label: nav.next, state: move('next') } : null,
                today: { label: nav.today, state: move('today') },
            },
            modes: getCalendarModeOptions(t).map((option) => ({
                mode: option.value,
                label: option.label,
                selected: option.value === period.viewMode,
                state: toState(selectCalendarViewMode(period, option.value, parseDayKey(dayKey(now))!)),
            })),
            showCompleted: { label: screen.showCompleted, hint: screen.showCompletedHint, on: ctx.showCompleted },
            text: { ...fixedText, toasts: { ...toasts, saveFailed: toasts.saveFailed() } },
            content,
            entries,
        };
    };

    const finish = (built: BuiltView, revision: string, window: { offset: number; limit: number }, now: Date): NativeCalendarView => {
        const pageEntries = built.entries.slice(window.offset, window.offset + window.limit);
        // Rows carry core meta; one row build per page, in entry order.
        const tasks: Task[] = [];
        for (const entry of pageEntries) {
            if (entry.type === 'task') tasks.push(entry.task);
            else if (entry.type === 'item' && entry.item.task) tasks.push(entry.item.task);
            else if (entry.type === 'day') for (const preview of entry.preview) if (preview.task) tasks.push(preview.task);
        }
        const rows = deps.rows(tasks, now);
        let rowIndex = 0;
        const done = ({ task, ...rest }: PendingItem): NativeCalendarItem => ({ ...rest, row: task ? rows[rowIndex++] ?? null : null });
        const items = pageEntries.map((entry): NativeCalendarEntry => {
            if (entry.type === 'day') return { ...entry, preview: entry.preview.map(done) };
            if (entry.type === 'item') return { ...entry, item: done(entry.item) };
            const { task: _task, ...rest } = entry;
            return { ...rest, row: rows[rowIndex++] };
        });
        const { entries, ...view } = built;
        return { version: NATIVE_HOST_CONTRACT_VERSION, revision, ...view, total: entries.length, items };
    };

    // ---- The composer ------------------------------------------------------------

    const composerDeps = (ctx: Context, events: (date: Date) => readonly ExternalCalendarEvent[]): CalendarComposerDeps => ({
        findFreeSlot: (day, durationMinutes, excludeTaskId) => findCalendarFreeSlot(day, durationMinutes, slotOptions(ctx, events(day), excludeTaskId)),
        timeEstimateToMinutes: ctx.estimateMinutes,
    });
    const composerView = (ctx: Context, state: CalendarViewComposerState): NativeCalendarComposerView => {
        const selectedTask = state.selectedTaskId ? ctx.store.tasks.find((task) => task.id === state.selectedTaskId) ?? null : null;
        return {
            composer: toComposer(state),
            timeLabels: {
                start: formatCalendarComposerClockValue(state.startTimeValue, state.startAt, ctx.formatDate),
                end: formatCalendarComposerClockValue(state.endTimeValue, state.startAt ? new Date(state.startAt.getTime() + state.durationMinutes * 60_000) : null, ctx.formatDate),
            },
            text: getCalendarComposerText(ctx.t, { priorities: ctx.flags.priorities }),
            dateLabel: ctx.dates.shortDate(state.date),
            placeholders: getCalendarComposerPlaceholders(ctx.formatDate),
            durations: CALENDAR_TIME_ESTIMATE_OPTIONS.map((option) => ({
                minutes: option.minutes, label: formatCalendarDurationChip(option.minutes), selected: state.durationMinutes === option.minutes,
            })),
            candidates: state.mode === 'existing'
                ? getCalendarComposerCandidates(ctx.schedulableTasks, state.query).map((task) => ({ id: task.id, title: task.title, selected: task.id === state.selectedTaskId }))
                : null,
            selectedTaskTitle: selectedTask?.title ?? null,
            error: state.error ? getCalendarComposerErrorText(state.error, ctx.t) : null,
            saveDisabled: isCalendarComposerSaveDisabled(state),
        };
    };
    const saveContext = (ctx: Context, events: (date: Date) => readonly ExternalCalendarEvent[], excludeCreatedId?: string): CalendarComposerSaveContext => ({
        areas: ctx.store.areas,
        projects: ctx.store.projects,
        parseOptions: buildQuickAddParseOptions(ctx.settings, { tasks: ctx.store.tasks, people: ctx.store.people }),
        // A retry of a create finds the task it made in the slot; that task is not in the way.
        isSlotFree: (start, durationMinutes, excludeTaskId) => isCalendarSlotFree(start, start, durationMinutes, slotOptions(ctx, events(start), excludeTaskId ?? excludeCreatedId)),
    });

    // ---- Actions -----------------------------------------------------------------

    type Outcome = NativeHostResult<NativeCalendarActionResult> | NativeUnsavedWrite<NativeCalendarActionResult>;
    const result = (fields: Partial<NativeCalendarActionResult> = {}): NativeCalendarActionResult => ({
        changed: false, toast: null, next: null, scrollToMinutes: null, composer: null, taskId: null, ...fields,
    });
    const unchanged = (fields: Partial<NativeCalendarActionResult> = {}): Outcome => ({ ok: true, value: result(fields) });
    const written = async (call: Parameters<typeof runStoreWrite>[0], fields: Partial<NativeCalendarActionResult> = {}): Promise<Outcome> => (
        settleWrite(await runStoreWrite(call), result({ ...fields, changed: true }))
    );
    const liveTask = (id: unknown): Task | undefined => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.deletedAt && !task.purgedAt ? task : undefined;
    };
    /** After a composer save the screen shows the day view on the new start, scrolled to it. */
    const dayView = (start: Date): Pick<NativeCalendarActionResult, 'next' | 'scrollToMinutes'> => ({
        next: { viewMode: 'day', selectedDate: dayKey(start), visibleMonth: dayKey(start) },
        scrollToMinutes: start.getHours() * 60 + start.getMinutes(),
    });
    const eventsByDay = (feed: Feed) => {
        const byDay = indexCalendarEvents(feed.events);
        return (date: Date): readonly ExternalCalendarEvent[] => byDay.get(calendarDateKey(date)) ?? [];
    };

    /**
     * A task this request made (the request ID is its id) answers a replay only
     * when it is still exactly what the request writes: its title and every field
     * the request sets. Anything else under that ID is refused.
     */
    const matchesPlan = (task: Task, title: string, props: Partial<Task>): boolean => (
        !task.deletedAt && !task.purgedAt && task.title === title
        && Object.entries(props).every(([field, planned]) => (
            JSON.stringify(task[field as keyof Task] ?? null) === JSON.stringify(planned ?? null)
        ))
    );
    const taskById = (id: string) => useTaskStore.getState()._allTasks.find((task) => task.id === id);
    const moveTarget = (action: Extract<NativeCalendarAction, { type: 'moveTask' }>) => (
        getCalendarMovedStart(parseDayKey(action.day)!.getTime(), action.startMinutes, safeParseDate(taskById(action.taskId)?.startTime)).toISOString()
    );
    const isMoveFree = (ctx: Context, feed: Feed, action: Extract<NativeCalendarAction, { type: 'moveTask' }>, taskId: string) => planCalendarTaskMove({
        taskId, dayStartMs: parseDayKey(action.day)!.getTime(), startMinutes: action.startMinutes, durationMinutes: action.durationMinutes,
        currentStart: safeParseDate(taskById(taskId)?.startTime),
        isSlotFree: (day, start, durationMinutes, excludeTaskId) => isCalendarSlotFree(day, start, durationMinutes, slotOptions(ctx, eventsByDay(feed)(day), excludeTaskId)),
    });

    /**
     * The write. It runs inside the receipts, so it checks everything again: a
     * write that does not apply returns ACTION_FAILED and leaves no receipt, and
     * a target that already holds writes nothing.
     */
    const perform = async (requestId: string, action: NativeCalendarAction, ctx: Context, feed: Feed, state: CalendarPeriodState): Promise<Outcome> => {
        const store = useTaskStore.getState();
        const events = eventsByDay(feed);
        switch (action.type) {
            case 'saveComposer': {
                const composer = readComposer(action.composer, ctx.formatDate)!;
                const createdId = requestId.toLowerCase();
                // The whole save is validated here, before any write: the task plan, its
                // dates and the slot. No refusal can follow a project write.
                const intent = prepareComposerSave(composer, saveContext(ctx, events, createdId));
                if (intent.kind === 'error') return fail('ACTION_FAILED', getCalendarComposerErrorText(intent.error, ctx.t));
                const answer = { ...dayView(composer.startAt!), taskId: intent.kind === 'update' ? intent.taskId : createdId };
                if (intent.kind === 'update') {
                    const task = liveTask(intent.taskId);
                    if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                    if (task.startTime === intent.updates.startTime && task.timeEstimate === intent.updates.timeEstimate) return unchanged(answer);
                    return written(() => store.updateTask(task.id, intent.updates), answer);
                }
                const existing = taskById(createdId);
                if (existing) {
                    // A replay after a restart: the project is found by name, the task by the request ID.
                    return matchesPlan(existing, intent.draft.title, intent.draft.props)
                        ? unchanged(answer)
                        : fail('INVALID_INPUT', 'Request ID already belongs to another task');
                }
                const landed = await runStoreWrite(async () => {
                    let draft = intent.draft;
                    if (intent.projectToCreate) {
                        const { name, color, initialProps } = intent.projectToCreate;
                        const project = await useTaskStore.getState().addProject(name, color, initialProps);
                        if (!project) return { success: false, error: 'Project creation failed' };
                        draft = applyComposerCreatedProject(draft, project.id);
                    }
                    return useTaskStore.getState().addTask(draft.title, draft.props, { captureId: requestId });
                });
                // Acknowledged only once the task exists. A project without its task did not
                // land the request: no receipt, and a retry finds the project by name and adds
                // the task.
                if (!taskById(createdId)) return fail('ACTION_FAILED', landed.ok ? 'Task creation failed' : landed.error.message);
                return settleWrite(landed, result({ ...answer, changed: true }));
            }
            case 'moveTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot move');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                const target = moveTarget(action);
                if (task.startTime === target) return unchanged();
                if (isMoveFree(ctx, feed, action, task.id).kind !== 'move') return fail('ACTION_FAILED', getCalendarToasts(ctx.t).timeConflict.message);
                return written(() => store.updateTask(task.id, { startTime: target }));
            }
            case 'unscheduleTask':
            case 'completeTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot change');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (action.type === 'unscheduleTask') {
                    if (!task.startTime) return unchanged();
                    return written(() => store.updateTask(task.id, { ...CALENDAR_UNSCHEDULE_UPDATES }));
                }
                if (task.status === 'done') return unchanged();
                return written(() => store.updateTask(task.id, { ...CALENDAR_DONE_UPDATES }));
            }
            case 'deleteTask': {
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot change');
                const task = typeof action.taskId === 'string' ? store._tasksById.get(action.taskId) : undefined;
                if (!task || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.deletedAt) return unchanged();
                return written(() => store.deleteTask(task.id));
            }
            case 'createTaskFromEvent': {
                const plan = planCalendarEventTask(action.event, { calendarName: getCalendarSourceNames(feed.calendars).get(action.event.sourceId), t: ctx.t });
                const createdId = requestId.toLowerCase();
                // The screen stays in its mode and moves to the event's day.
                const next = plan.showDate ? toState({ ...state, selectedDate: plan.showDate, visibleMonthDate: plan.showDate }) : null;
                const answer = { toast: getCalendarToasts(ctx.t).eventTaskCreated, next, taskId: createdId };
                const existing = taskById(createdId);
                if (existing) {
                    // The event's start or date, duration, place and notes: the whole task the event makes.
                    return matchesPlan(existing, plan.title, plan.initialProps)
                        ? unchanged(answer)
                        : fail('INVALID_INPUT', 'Request ID already belongs to another task');
                }
                return written(async () => {
                    const added = await store.addTask(plan.title, plan.initialProps, { captureId: requestId });
                    return added.success && added.id !== createdId ? { success: false, error: 'Task creation failed' } : added;
                }, answer);
            }
            case 'setViewMode':
            case 'setShowCompleted':
            case 'setWeekVisibleDays': {
                const calendar = ctx.settings.calendar;
                const patch = action.type === 'setViewMode'
                    ? { viewMode: action.viewMode }
                    : action.type === 'setShowCompleted'
                        ? { showCompleted: action.on }
                        : { weekVisibleDays: coerceCalendarWeekVisibleDays(action.days) };
                const current = action.type === 'setViewMode'
                    ? calendar?.viewMode
                    : action.type === 'setShowCompleted'
                        ? calendar?.showCompleted === true
                        : coerceCalendarWeekVisibleDays(calendar?.weekVisibleDays);
                if (Object.values(patch)[0] === current) return unchanged();
                return written(() => store.updateSettings({ calendar: { ...calendar, ...patch } }));
            }
            default:
                return fail('INVALID_INPUT', 'The calendar does not offer that action');
        }
    };

    /**
     * A new request's input checks and the refusals the screen shows (a time
     * conflict, a composer error). A refusal writes nothing and stays out of the
     * receipts, so its request ID stays free. A request the receipts already hold
     * skips these checks (runCalendarAction).
     */
    const check = (requestId: string, action: NativeCalendarAction, ctx: Context, feed: Feed): Outcome | null => {
        switch (action.type) {
            case 'saveComposer': {
                const composer = readComposer(action.composer, ctx.formatDate);
                if (!composer) return fail('INVALID_INPUT', 'A composer from openCalendarComposer is required');
                // A task under this ID is a replay: the write checks it is this request's.
                if (taskById(requestId.toLowerCase())) return null;
                if (isCalendarComposerSaveDisabled(composer)) return fail('INVALID_INPUT', 'Save is not available yet');
                const intent = prepareComposerSave(composer, saveContext(ctx, eventsByDay(feed)));
                if (intent.kind !== 'error') return null;
                return unchanged({ composer: composerView(ctx, { ...composer, error: intent.error }) });
            }
            case 'moveTask': {
                if (!parseDayKey(action.day) || !Number.isSafeInteger(action.startMinutes) || action.startMinutes < 0
                    || !Number.isSafeInteger(action.durationMinutes) || action.durationMinutes < 1
                    || action.startMinutes + action.durationMinutes > 24 * 60) {
                    return fail('INVALID_INPUT', 'A day, a start minute and a duration inside the day are required');
                }
                if (isProjectedRecurringTaskId(action.taskId)) return fail('INVALID_INPUT', 'A projected occurrence cannot move');
                const task = liveTask(action.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (task.startTime === moveTarget(action)) return null;
                return isMoveFree(ctx, feed, action, task.id).kind === 'move' ? null : unchanged({ toast: getCalendarToasts(ctx.t).timeConflict });
            }
            case 'unscheduleTask':
            case 'completeTask':
            case 'deleteTask':
                return isText(action.taskId) ? null : fail('INVALID_INPUT', 'A task id is required');
            case 'createTaskFromEvent':
                return isEvent(action.event) ? null : fail('INVALID_INPUT', 'An event from the calendar feed is required');
            case 'setViewMode':
                return CALENDAR_VIEW_MODES.includes(action.viewMode) ? null : fail('INVALID_INPUT', 'A calendar view mode is required');
            case 'setShowCompleted':
                return typeof action.on === 'boolean' ? null : fail('INVALID_INPUT', 'on must be a boolean');
            case 'setWeekVisibleDays':
                return CALENDAR_WEEK_DENSITY_VALUES.includes(action.days) ? null : fail('INVALID_INPUT', 'A week density from the view is required');
            default:
                return fail('INVALID_INPUT', 'The calendar does not offer that action');
        }
    };

    return {
        /**
         * The Calendar in `state` (absent: the screen as it opens, in the saved
         * view mode on today), windowed. Fetch external events for `range` and send
         * them as `calendar`; `scheduleQuery` is the search under the selected day.
         */
        getCalendarView(input: {
            state?: NativeCalendarState;
            scheduleQuery?: string;
            calendar?: NativeCalendarFeed;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeCalendarView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            anchorProjections(now);
            const settings = useTaskStore.getState().settings;
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            const period = isObjectRecord(input) ? readState(input.state, { settings, now }) : null;
            const query = isObjectRecord(input) ? input.scheduleQuery ?? '' : null;
            if (!isObjectRecord(input) || !isPaging(input) || !feed || !period || !isText(query, 2000)) {
                return fail('INVALID_INPUT', 'A valid state, calendar, schedule query, offset, bounded limit and revision for later pages are required');
            }
            const revision = `${deps.revision(now)}:${paramsKey([toState(period), query, feed, projectedAt.iso])}`;
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'The calendar changed; restart paging from offset zero');
            // The store, settings and language are in the revision; a later page reuses the build.
            if (cachedView?.key !== revision) cachedView = { key: revision, value: build(context(now), period, feed, query) };
            return { ok: true, value: finish(cachedView.value, revision, input as { offset: number; limit: number }, now) };
        },

        /**
         * What pressing an item offers: a task's sheet (Edit, Remove from calendar,
         * Done, Delete, Cancel; a projected occurrence only explains itself) or an
         * event's (Create task, Open in calendar when the host can open it, Cancel).
         * Edit opens the task editor; the rest are runCalendarAction. Send the view's
         * state and calendar: as on mobile, only the view's open tasks and projected
         * occurrences offer a sheet, and a completed item answers TASK_NOT_FOUND.
         */
        getCalendarItemSheet(input:
            | { taskId: string; state?: NativeCalendarState; calendar?: NativeCalendarFeed }
            | { event: ExternalCalendarEvent; canOpen: boolean }): NativeHostResult<NativeCalendarSheet> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            if (isObjectRecord(input) && 'event' in input) {
                if (!isEvent(input.event) || typeof input.canOpen !== 'boolean') return fail('INVALID_INPUT', 'An event and whether the host can open it are required');
                return { ok: true, value: { kind: 'event', ...getCalendarEventSheet(input.event, { canOpen: input.canOpen, t: ctx.t }) } };
            }
            if (!isObjectRecord(input) || !isText(input.taskId)) return fail('INVALID_INPUT', 'A task id or an event is required');
            const period = readState(input.state, ctx);
            const feed = readFeed(input.calendar);
            if (!period || !feed) return fail('INVALID_INPUT', 'The view\'s state and calendar are required');
            const task = periodIndex(ctx, period, feed).rangeTasks.find((candidate) => candidate.id === input.taskId);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            const sheet = getCalendarTaskSheet(task, ctx.t);
            return { ok: true, value: sheet.kind === 'projected' ? sheet : { ...sheet, kind: 'task', taskId: task.id } };
        },

        /**
         * Open the composer: at an instant (a timeline tap), on a day at its first
         * free slot (Add task, a week column), or for a task to schedule on the
         * selected day (a planning or search row), which refuses with the no-free-time
         * toast when the day is full.
         */
        openCalendarComposer(input: {
            at?: string;
            day?: string;
            scheduleTaskId?: string;
            mode?: CalendarComposerMode;
            calendar?: NativeCalendarFeed;
        }): NativeHostResult<{ composer: NativeCalendarComposerView | null; toast: CalendarToast | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            if (!isObjectRecord(input) || !feed || (input.mode !== undefined && input.mode !== 'new' && input.mode !== 'existing')) {
                return fail('INVALID_INPUT', 'An instant, a day or a task to schedule, and the calendar, are required');
            }
            const events = eventsByDay(feed);
            const openDeps = composerDeps(ctx, events);
            const at = isText(input.at, ISO_INSTANT_LIMIT) ? safeParseDate(input.at) : null;
            const day = parseDayKey(input.day);
            if (input.scheduleTaskId !== undefined) {
                const task = ctx.schedulableTasks.find((candidate) => candidate.id === input.scheduleTaskId);
                if (!task || !day) return fail('INVALID_INPUT', 'A task the planning list offers and the selected day are required');
                const durationMinutes = ctx.estimateMinutes(task.timeEstimate);
                const slot = openDeps.findFreeSlot(day, durationMinutes, task.id);
                if (!slot) return { ok: true, value: { composer: null, toast: getCalendarToasts(ctx.t).noFreeTime } };
                return { ok: true, value: { composer: composerView(ctx, toCalendarViewComposer(openComposerAt(slot, { durationMinutes, mode: 'existing', task }, openDeps), slot)), toast: null } };
            }
            if (at) return { ok: true, value: { composer: composerView(ctx, toCalendarViewComposer(openComposerAt(at, { mode: input.mode ?? 'new' }, openDeps), at)), toast: null } };
            if (day) return { ok: true, value: { composer: composerView(ctx, toCalendarViewComposer(openComposerForDate(day, { mode: input.mode ?? 'new' }, openDeps), day)), toast: null } };
            return fail('INVALID_INPUT', 'An instant, a day or a task to schedule is required');
        },

        /** Apply one composer edit and return the composer after it. Nothing is written. */
        editCalendarComposer(input: { composer: NativeCalendarComposer; edit: NativeCalendarComposerEdit; calendar?: NativeCalendarFeed }): NativeHostResult<NativeCalendarComposerView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const now = new Date();
            const ctx = context(now);
            const state = isObjectRecord(input) ? readComposer(input.composer, ctx.formatDate) : null;
            const feed = isObjectRecord(input) ? readFeed(input.calendar) : null;
            const edit = isObjectRecord(input) && isObjectRecord(input.edit) ? input.edit as NativeCalendarComposerEdit : null;
            if (!state || !feed || !edit) return fail('INVALID_INPUT', 'A composer, an edit and the calendar are required');
            const events = eventsByDay(feed);
            let next: CalendarViewComposerState | null = null;
            switch (edit.type) {
                case 'mode':
                    if (edit.mode === 'new' || edit.mode === 'existing') next = { ...state, ...setComposerMode(state, edit.mode) };
                    break;
                case 'title':
                    if (isText(edit.title, 10_000)) next = { ...state, ...setComposerTitle(state, edit.title) };
                    break;
                case 'query':
                    if (isText(edit.query, 2000)) next = { ...state, ...setComposerQuery(state, edit.query) };
                    break;
                case 'selectTask': {
                    const task = ctx.schedulableTasks.find((candidate) => candidate.id === edit.taskId);
                    if (task) next = { ...state, ...selectComposerTask(state, task, composerDeps(ctx, events)) };
                    break;
                }
                case 'startTime':
                    if (isText(edit.value, 64)) next = setCalendarViewComposerStartTime(state, edit.value);
                    break;
                case 'endTime':
                    if (isText(edit.value, 64)) next = { ...state, ...setComposerEndTime(state, edit.value) };
                    break;
                case 'duration':
                    if (Number.isSafeInteger(edit.minutes) && edit.minutes >= 1 && edit.minutes <= 24 * 60) next = { ...state, ...setComposerDuration(state, edit.minutes) };
                    break;
                default:
                    break;
            }
            if (!next) return fail('INVALID_INPUT', 'That composer edit is not valid');
            return { ok: true, value: composerView(ctx, next) };
        },

        /**
         * One calendar action, as the screen writes it. Reuse `requestId` to retry:
         * a completed request writes nothing again. Send the `calendar` the view
         * shows: a move and a composer save check the day's events for overlaps, and
         * an event task names its calendar.
         */
        async runCalendarAction(input: {
            requestId: string;
            action: NativeCalendarAction;
            state?: NativeCalendarState;
            calendar?: NativeCalendarFeed;
        }): Promise<NativeHostResult<NativeCalendarActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action) || typeof input.requestId !== 'string') {
                return fail('INVALID_INPUT', 'A request UUID and an action are required');
            }
            const ctx = context(new Date());
            const feed = readFeed(input.calendar);
            const state = readState(input.state, ctx);
            if (!feed || !state) return fail('INVALID_INPUT', 'The view\'s state and a calendar that is loading, ready or an error are required');
            const action = input.action as NativeCalendarAction;
            const requestId = input.requestId;
            const payload = JSON.stringify(['calendar', action]);
            // The receipts come first: a request that is running or owes its save skips the
            // checks of a new request (the slot may be taken since), and only saves.
            const known = entered.get(requestId);
            if (known === undefined) {
                const refused = check(requestId, action, ctx, feed);
                if (refused) return refused as NativeHostResult<NativeCalendarActionResult>;
                entered.set(requestId, payload);
                if (entered.size > ENTERED_LIMIT) entered.delete(entered.keys().next().value!);
            }
            const outcome = await receipts.run(requestId, payload, () => perform(requestId, action, context(new Date()), feed, state));
            // A write that did not land leaves no receipt; another payload under a known ID was refused and changes nothing.
            if (!outcome.ok && outcome.error.code !== 'SAVE_FAILED' && (known === undefined || known === payload)) entered.delete(requestId);
            return outcome;
        },
    };
}
