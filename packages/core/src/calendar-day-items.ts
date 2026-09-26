/**
 * Day-cell content shared by the desktop and mobile calendars: the merged
 * scheduled/deadline/event list for a date, and the overlap layout for timed
 * blocks.
 */
import { safeParseDate, safeParseDueDate } from './date';
import type { ExternalCalendarEvent } from './ics';
import { isProjectedRecurringTask } from './recurrence';
import { isTaskActionable, isTaskCompleted } from './task-status';
import type { Task } from './types';

/**
 * The instant a done/archived task is filed under in the calendar's look-back
 * (#955). Falls back to `updatedAt` for tasks archived before completion
 * timestamps were recorded, which is the same thing the Archive list shows as
 * their completion time — without it those tasks would silently never appear.
 */
export const getTaskCompletionInstant = (
    task: Pick<Task, 'status' | 'cancelledAt' | 'completedAt' | 'updatedAt'>,
): Date | null => (
    isTaskCompleted(task) ? safeParseDate(task.completedAt ?? task.updatedAt) : null
);

/**
 * Whether a task belongs in the calendar's completed look-back. Callers still
 * apply the calendar's project/area visibility on top; this is only the
 * status half, kept here so desktop and mobile cannot drift apart.
 */
export const isCompletedCalendarTask = (task: Task): boolean => (
    !task.deletedAt
    && isTaskCompleted(task)
    && getTaskCompletionInstant(task) !== null
);

/**
 * Whether a task belongs in the scheduled/deadline buckets — the status half of
 * calendar visibility, and the exact complement of the look-back above.
 *
 * This lives here because the two platforms had drifted: desktop filtered these
 * statuses out of its day maps while mobile did not, so finished work still sat
 * on its old start date on a phone and nowhere on a desktop (#955).
 */
export const isSchedulableCalendarTask = (task: Task): boolean => (
    !task.deletedAt
    && isTaskActionable(task)
);

export type CalendarDayItem =
    | { id: string; kind: 'scheduled'; start: Date | null; task: Task; title: string }
    | { id: string; kind: 'deadline'; start: Date | null; task: Task; title: string }
    | { id: string; kind: 'completed'; start: Date | null; task: Task; title: string }
    | { event: ExternalCalendarEvent; id: string; kind: 'event'; start: Date | null; title: string };

export type CalendarDayItemsInput = {
    /** Done/archived tasks placed on the day they were completed (#955). Empty
     *  unless the calendar's "show completed" toggle is on. */
    completed?: readonly Task[];
    deadlines: readonly Task[];
    events: readonly ExternalCalendarEvent[];
    scheduled: readonly Task[];
};

/**
 * Merges a day's scheduled tasks, deadline-only tasks, completed tasks and
 * external events into one time-ordered list. A task that is both scheduled and
 * due that day appears once, as its scheduled block. Undated items sort last,
 * then by title.
 *
 * Completed tasks need no such de-duplication: a done or archived task is
 * excluded from the scheduled and deadline buckets by the caller's visibility
 * rule, so it can only ever appear here as its completion.
 */
export function buildCalendarDayItems({ completed = [], deadlines, events, scheduled }: CalendarDayItemsInput): CalendarDayItem[] {
    return [
        ...completed.filter(isCompletedCalendarTask).map((task): CalendarDayItem => ({
            id: `completed-${task.id}`,
            kind: 'completed',
            start: getTaskCompletionInstant(task),
            task,
            title: task.title,
        })),
        ...scheduled.map((task): CalendarDayItem => ({
            id: `scheduled-${task.id}`,
            kind: 'scheduled',
            start: task.startTime ? safeParseDate(task.startTime) : null,
            task,
            title: task.title,
        })),
        ...getCalendarDistinctDeadlines(deadlines, scheduled)
            .map((task): CalendarDayItem => ({
                id: `deadline-${task.id}`,
                kind: 'deadline',
                start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
                task,
                title: task.title,
            })),
        ...events.map((event): CalendarDayItem => ({
            event,
            id: `event-${event.id}`,
            kind: 'event',
            start: safeParseDate(event.start),
            title: event.title,
        })),
    ].sort((a, b) => {
        const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return a.title.localeCompare(b.title);
    });
}

export const getCalendarDistinctDeadlines = (deadlines: readonly Task[], scheduled: readonly Task[]): Task[] => {
    const scheduledIds = new Set(scheduled.map((task) => task.id));
    return deadlines.filter((task) => !scheduledIds.has(task.id));
};

type LimitedSlotCalendarItem = {
    kind: 'scheduled' | 'deadline' | 'completed' | 'event';
    task?: Task;
};

/**
 * Priority order for surfaces with a fixed number of visible rows — the month
 * grid cell and the week view's all-day lane. Projected recurring occurrences
 * repeat on every matching day, so in time order they crowd one-off items out
 * of the few visible rows; here real tasks and events keep their existing
 * order first and projections fill whatever rows remain. Unlimited surfaces
 * (day view, the selected-day list) keep pure time order.
 */
export function orderCalendarDayItemsForLimitedSlots<T extends LimitedSlotCalendarItem>(
    items: readonly T[]
): T[] {
    const real: T[] = [];
    const projected: T[] = [];
    for (const item of items) {
        const isProjection = (item.kind === 'scheduled' || item.kind === 'deadline')
            && isProjectedRecurringTask(item.task);
        (isProjection ? projected : real).push(item);
    }
    return projected.length === 0 ? [...items] : [...real, ...projected];
}

export type CalendarTimedLayoutInput = {
    id: string;
    startMinutes: number;
    endMinutes: number;
};

export type CalendarTimedLayout = {
    columnCount: number;
    columnIndex: number;
    leftPercent: number;
    widthPercent: number;
};

type TimedLayoutItem = CalendarTimedLayoutInput & {
    index: number;
};

type TimedLayoutWorkingItem = TimedLayoutItem & {
    columnIndex: number;
};

/**
 * Side-by-side layout for overlapping timed blocks.
 *
 * The column count is computed per overlap cluster, not per day: two meetings
 * hours apart are separate clusters and each stays full width, while a cluster
 * of three splits into thirds.
 */
export const buildTimedCalendarLayouts = (
    items: readonly CalendarTimedLayoutInput[]
): Map<string, CalendarTimedLayout> => {
    const layouts = new Map<string, CalendarTimedLayout>();
    const normalizedItems = items
        .map<TimedLayoutItem | null>((item, index) => {
            if (!Number.isFinite(item.startMinutes) || !Number.isFinite(item.endMinutes)) return null;
            const startMinutes = Math.min(item.startMinutes, item.endMinutes);
            const endMinutes = Math.max(item.startMinutes, item.endMinutes);
            if (endMinutes <= startMinutes) return null;
            return { ...item, startMinutes, endMinutes, index };
        })
        .filter((item): item is TimedLayoutItem => Boolean(item))
        .sort((a, b) =>
            a.startMinutes - b.startMinutes
            || a.endMinutes - b.endMinutes
            || a.index - b.index
        );

    let activeItems: TimedLayoutWorkingItem[] = [];
    let groupItems: TimedLayoutWorkingItem[] = [];

    const flushGroup = () => {
        if (groupItems.length === 0) return;
        const columnCount = Math.max(1, ...groupItems.map((item) => item.columnIndex + 1));
        const widthPercent = 100 / columnCount;
        for (const item of groupItems) {
            layouts.set(item.id, {
                columnCount,
                columnIndex: item.columnIndex,
                leftPercent: item.columnIndex * widthPercent,
                widthPercent,
            });
        }
        groupItems = [];
    };

    for (const item of normalizedItems) {
        activeItems = activeItems.filter((active) => active.endMinutes > item.startMinutes);
        if (activeItems.length === 0) {
            flushGroup();
        }

        const occupiedColumns = new Set(activeItems.map((active) => active.columnIndex));
        let columnIndex = 0;
        while (occupiedColumns.has(columnIndex)) columnIndex += 1;

        const workingItem = { ...item, columnIndex };
        activeItems.push(workingItem);
        groupItems.push(workingItem);
    }

    flushGroup();

    return layouts;
};
