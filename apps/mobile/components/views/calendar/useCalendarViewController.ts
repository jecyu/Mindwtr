import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  AppState,
  Platform,
  type AlertButton,
  type AppStateStatus,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildQuickAddParseOptions,
  CALENDAR_DAY_END_HOUR,
  CALENDAR_DAY_MINUTES,
  CALENDAR_DAY_START_HOUR,
  CALENDAR_DONE_UPDATES,
  CALENDAR_SNAP_MINUTES,
  CALENDAR_UNSCHEDULE_UPDATES,
  calendarDateKey,
  coerceCalendarViewMode,
  coerceCalendarWeekVisibleDays,
  createCalendarLocaleDates,
  createCalendarSourceColorResolver,
  findCalendarFreeSlot,
  formatCalendarHourLabel,
  formatCalendarMonthTitle,
  formatCalendarSelectedDateLabels,
  formatCalendarWeekTitle,
  getCalendarComposerCandidates,
  getCalendarComposerErrorText,
  getCalendarDayItems,
  getCalendarDayLists,
  getCalendarDayNames,
  getCalendarDayTimedTasks,
  getCalendarEventSheet,
  getCalendarLocale,
  getCalendarMonthDates,
  getCalendarMonthGrid,
  getCalendarNowMinutes,
  getCalendarPlanningTasks,
  getCalendarRangeTasks,
  getCalendarSchedulableTasks,
  getCalendarScheduleActionLabel,
  getCalendarScheduleSections,
  getCalendarSearchResults,
  getCalendarSourceNames,
  getCalendarSystem,
  getCalendarTaskSheet,
  getCalendarToasts,
  getCalendarVisibleRange,
  getCalendarWeekDays,
  getCalendarWeekStart,
  getCalendarWeekVisibleDaysUpdate,
  getInitialCalendarSelectedDate,
  getWeekStartsOnIndex,
  indexCalendarCompletedTasks,
  indexCalendarDeadlineTasks,
  indexCalendarEvents,
  indexCalendarScheduledTasks,
  isCalendarSlotFree,
  isSameCalendarDate,
  moveCalendarPeriod,
  needsCalendarSelectedDate,
  planCalendarEventTask,
  planCalendarTaskMove,
  resolveFeatureFlags,
  safeFormatDate,
  safeParseDate,
  setCalendarViewComposerStartTime,
  shallow,
  shiftCalendarSelectedDate,
  startOfCalendarMonth,
  timeEstimateToMinutes as resolveTimeEstimateToMinutes,
  toCalendarViewComposer,
  useTaskStore,
  type CalendarPeriodMove,
  type CalendarSettings,
  type CalendarViewComposerState,
  type CalendarViewMode,
  type ExternalCalendarEvent,
  type ExternalCalendarSubscription,
  type Task,
} from '@mindwtr/core';
import {
  executeComposerSave,
  openComposerAt,
  openComposerForDate,
  selectComposerTask,
  setComposerDuration,
  setComposerEndTime,
  setComposerMode,
  setComposerQuery,
  setComposerTitle,
  type CalendarComposerDeps,
  type CalendarComposerError,
  type CalendarComposerMode,
  type CalendarComposerState,
} from '@mindwtr/core/calendar-composer';

import { useTheme } from '../../../contexts/theme-context';
import { useToast } from '../../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useLanguage } from '../../../contexts/language-context';
import { canOpenExternalCalendarEvent, fetchExternalCalendarEvents, openExternalCalendarEvent } from '../../../lib/external-calendar';
import { logError, logInfo } from '../../../lib/app-log';
import {
  getCalendarTimelineAnchorMinutes,
  getCalendarTimelineDefaultScrollKey,
  getCalendarTimelineScrollYForMinutes,
} from './calendar-view-mode';
import {
  EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS,
  shouldRefreshExternalCalendarOnAppStateChange,
} from './calendar-external-refresh';

const DAY_START_HOUR = CALENDAR_DAY_START_HOUR;
const DAY_END_HOUR = CALENDAR_DAY_END_HOUR;
const PIXELS_PER_MINUTE = 1.4;
const DAY_TIMELINE_MINUTES = CALENDAR_DAY_MINUTES;
const SNAP_MINUTES = CALENDAR_SNAP_MINUTES;
type CalendarTaskComposerMode = CalendarComposerMode;
/** Shared composer state plus the mobile day and free-text time input. */
type CalendarTaskComposerState = CalendarViewComposerState;

const isSameDay = isSameCalendarDate;

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

export function useCalendarViewController() {
  const { tasks, allTasks, projects, sections, areas, addTask, addProject, updateTask, deleteTask, people, updateSettings, settings } = useTaskStore((state) => ({
    tasks: state.tasks,
    people: state.people,
    // Archived tasks are absent from the visible `tasks` projection, so the
    // completed look-back reads the full list like the Archive screen (#955).
    allTasks: state._allTasks,
    projects: state.projects,
    sections: state.sections,
    areas: state.areas,
    addProject: state.addProject,
    addTask: state.addTask,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    updateSettings: state.updateSettings,
    settings: state.settings,
  }), shallow);
  const { isDark, themePreset } = useTheme();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const { t, language } = useLanguage();
  const { areaById, projectById, resolvedAreaFilter, visibleTasks: areaVisibleTasks } = useVisibleTaskContext();
  const quickAddParseOptions = useMemo(
    () => buildQuickAddParseOptions(settings, { tasks, people }),
    [people, settings, tasks],
  );

  const toRgba = (hex: string, alpha: number) => {
    const normalized = hex.replace('#', '');
    const full = normalized.length === 3
      ? normalized.split('').map((c) => c + c).join('')
      : normalized.padEnd(6, '0');
    const intVal = Number.parseInt(full, 16);
    const r = (intVal >> 16) & 255;
    const g = (intVal >> 8) & 255;
    const b = intVal & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
  const calendarSettings: CalendarSettings | undefined = settings?.calendar;
  const today = new Date();
  const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
    ? Intl.DateTimeFormat().resolvedOptions().locale
    : '';
  const calendarSystem = getCalendarSystem({ language, settings, systemLocale });
  const initialViewMode = coerceCalendarViewMode(calendarSettings?.viewMode);
  const calendarWeekVisibleDays = coerceCalendarWeekVisibleDays(calendarSettings?.weekVisibleDays);
  const calendarSettingsRef = useRef(calendarSettings);
  const requestedCalendarWeekVisibleDaysRef = useRef(calendarWeekVisibleDays);
  const showCompleted = calendarSettings?.showCompleted === true;
  const [visibleMonthDate, setVisibleMonthDate] = useState(today);
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => getInitialCalendarSelectedDate(initialViewMode, today));
  const [viewMode, setViewModeState] = useState<CalendarViewMode>(() => initialViewMode);
  const pendingViewModeSaveRef = useRef<CalendarViewMode | null>(null);
  const selectedDateRef = useRef<Date | null>(selectedDate);
  const viewModeRef = useRef<CalendarViewMode>(viewMode);
  const [scheduleQuery, setScheduleQuery] = useState('');
  const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [externalEventsRange, setExternalEventsRange] = useState('');
  const loadedExternalRangeRef = useRef('');
  const [externalError, setExternalError] = useState<string | null>(null);
  const [isExternalLoading, setIsExternalLoading] = useState(false);
  const [externalRefreshToken, setExternalRefreshToken] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const nowTickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasHandledInitialFocusRef = useRef(false);
  const lastExternalRefreshRequestMsRef = useRef(0);
  const timelineScrollRef = useRef<any>(null);
  const timelineScrollOffsetRef = useRef(0);
  const timelineContentTopRef = useRef(0);
  const timelineAnchorMinutesRef = useRef<number | null>(null);
  const lastDayTimelineRestoreKeyRef = useRef('');
  const [pendingScrollMinutes, setPendingScrollMinutes] = useState<number | null>(null);
  const lastDefaultTimelineScrollKeyRef = useRef('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [calendarComposer, setCalendarComposer] = useState<CalendarTaskComposerState | null>(null);

  const logCalendarError = (error: unknown) => {
    void logError(error, { scope: 'calendar' });
  };
  useEffect(() => {
    calendarSettingsRef.current = calendarSettings;
  }, [calendarSettings]);
  useEffect(() => {
    requestedCalendarWeekVisibleDaysRef.current = calendarWeekVisibleDays;
  }, [calendarWeekVisibleDays]);
  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  const ensureSelectedDateForViewMode = useCallback((nextMode: CalendarViewMode) => {
    if (!needsCalendarSelectedDate(nextMode) || selectedDateRef.current) return;
    const nextDate = new Date();
    selectedDateRef.current = nextDate;
    setSelectedDate(nextDate);
    setVisibleMonthDate(nextDate);
  }, []);
  const setViewMode = (nextMode: CalendarViewMode) => {
    ensureSelectedDateForViewMode(nextMode);
    pendingViewModeSaveRef.current = nextMode;
    setViewModeState(nextMode);
    updateSettings({ calendar: { ...calendarSettings, viewMode: nextMode } })
      .catch(logCalendarError);
  };

  const toggleShowCompleted = () => {
    updateSettings({ calendar: { ...calendarSettings, showCompleted: !showCompleted } })
      .catch(logCalendarError);
  };

  const setCalendarWeekVisibleDays = useCallback((visibleDays: number) => {
    const previousVisibleDays = requestedCalendarWeekVisibleDaysRef.current;
    const nextVisibleDays = getCalendarWeekVisibleDaysUpdate({
      currentVisibleDays: previousVisibleDays,
      requestedVisibleDays: visibleDays,
    });
    if (nextVisibleDays === null) return;

    // A pan gesture emits many frames for each integer tick. Record the
    // requested value before persistence so stale callback closures cannot
    // enqueue the same settings write on every frame.
    requestedCalendarWeekVisibleDaysRef.current = nextVisibleDays;
    updateSettings({
      calendar: {
        ...calendarSettingsRef.current,
        weekVisibleDays: nextVisibleDays,
      },
    }).catch((error) => {
      if (requestedCalendarWeekVisibleDaysRef.current === nextVisibleDays) {
        requestedCalendarWeekVisibleDaysRef.current = previousVisibleDays;
      }
      void logError(error, { scope: 'calendar' });
    });
  }, [updateSettings]);

  useEffect(() => {
    ensureSelectedDateForViewMode(viewMode);
  }, [ensureSelectedDateForViewMode, viewMode]);

  useEffect(() => {
    const storedViewMode = calendarSettings?.viewMode;
    if (!storedViewMode) return;
    const nextMode = coerceCalendarViewMode(storedViewMode);
    if (pendingViewModeSaveRef.current) {
      if (pendingViewModeSaveRef.current === nextMode) {
        pendingViewModeSaveRef.current = null;
      } else {
        return;
      }
    }
    if (viewModeRef.current === nextMode) return;
    setViewModeState(nextMode);
    ensureSelectedDateForViewMode(nextMode);
  }, [calendarSettings?.viewMode, ensureSelectedDateForViewMode]);

  const weekStartIndex = getWeekStartsOnIndex(settings?.weekStart);
  const currentMonthDate = useMemo(
    () => startOfCalendarMonth(visibleMonthDate, calendarSystem),
    [calendarSystem, visibleMonthDate],
  );
  const monthDates = useMemo(
    () => getCalendarMonthDates(currentMonthDate, calendarSystem),
    [calendarSystem, currentMonthDate],
  );
  const locale = getCalendarLocale({ language, settings, systemLocale });
  const calendarDates = useMemo(() => createCalendarLocaleDates(locale), [locale]);
  const monthLabel = formatCalendarMonthTitle(currentMonthDate, calendarDates);
  const dayNames = getCalendarDayNames(calendarDates, weekStartIndex);
  const weekStartDate = useMemo(() => (
    getCalendarWeekStart(selectedDate ?? currentMonthDate, weekStartIndex)
  ), [currentMonthDate, selectedDate, weekStartIndex]);
  const weekStartTime = weekStartDate.getTime();
  const weekDays = useMemo(() => getCalendarWeekDays(weekStartTime), [weekStartTime]);
  const weekLabel = useMemo(() => formatCalendarWeekTitle(weekDays, calendarDates), [calendarDates, weekDays]);
  const defaultTimelineScrollKey = useMemo(() => getCalendarTimelineDefaultScrollKey({
    selectedDate,
    viewMode,
    weekStartTime,
  }), [selectedDate, viewMode, weekStartTime]);

  // The same visible-window bounds used to fetch/clip external calendar events
  // below double as the recurrence range: whatever window the month grid, week
  // strip, or schedule list is currently showing is exactly what a "show future
  // recurrence" task should paint every occurrence into (#calendar-range-projection).
  const externalCalendarRange = useMemo(() => getCalendarVisibleRange({
    calendarSystem,
    currentMonthDate,
    selectedDate,
    viewMode,
    weekStartTime,
  }), [calendarSystem, currentMonthDate, selectedDate, viewMode, weekStartTime]);

  // Primitive bounds, not the `externalCalendarRange` object: in month mode the window's actual
  // start/end don't change when the selected day or week-start reference does, but the object's
  // identity does, and re-expanding every recurring task's whole range on every day tap is exactly
  // the "unrelated state change" P19 says must not re-enumerate.
  const externalRangeStartMs = externalCalendarRange.rangeStart.getTime();
  const externalRangeEndMs = externalCalendarRange.rangeEnd.getTime();
  const externalRangeKey = `${externalRangeStartMs}:${externalRangeEndMs}`;
  const recurrenceProjectionDayKey = calendarDateKey(new Date(nowTick));
  const recurrenceProjectedAtIso = useMemo(
    () => new Date(nowTick).toISOString(),
    // A calendar projection changes at a local-day boundary, not on every
    // minute tick used by the current-time line and planning suggestions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recurrenceProjectionDayKey],
  );

  const visibleTasks = useMemo(() => getCalendarRangeTasks(
    areaVisibleTasks,
    { rangeStartMs: externalRangeStartMs, rangeEndMs: externalRangeEndMs },
    recurrenceProjectedAtIso,
  ), [areaVisibleTasks, externalRangeStartMs, externalRangeEndMs, recurrenceProjectedAtIso]);

  const completedTasksByDate = useMemo(() => indexCalendarCompletedTasks(allTasks, {
    showCompleted, projectById, areaById, resolvedAreaFilter,
  }), [allTasks, showCompleted, projectById, resolvedAreaFilter, areaById]);

  const schedulableTasks = useMemo(() => getCalendarSchedulableTasks(areaVisibleTasks), [areaVisibleTasks]);

  const visibleSchedulableTasks = schedulableTasks;

  const scheduledTasksByDate = useMemo(() => indexCalendarScheduledTasks(visibleTasks), [visibleTasks]);

  const deadlineTasksByDate = useMemo(() => indexCalendarDeadlineTasks(visibleTasks), [visibleTasks]);

  const externalEventsByDate = useMemo(() => indexCalendarEvents(externalEventsRange === externalRangeKey ? externalEvents : []), [externalEvents, externalEventsRange, externalRangeKey]);

  const getDayLists = useCallback((date: Date) => getCalendarDayLists({
    completed: completedTasksByDate,
    deadlines: deadlineTasksByDate,
    events: externalEventsByDate,
    scheduled: scheduledTasksByDate,
  }, date), [completedTasksByDate, deadlineTasksByDate, externalEventsByDate, scheduledTasksByDate]);

  const getDeadlinesForDate = useCallback((date: Date): Task[] => getDayLists(date).deadlines, [getDayLists]);

  const getScheduledForDate = useCallback((date: Date): Task[] => getDayLists(date).scheduled, [getDayLists]);

  const getExternalEventsForDate = useCallback((date: Date) => getDayLists(date).events, [getDayLists]);

  const getCalendarItemsForDate = useCallback((date: Date) => getCalendarDayItems(getDayLists(date)), [getDayLists]);

  const timeEstimateToMinutes = (estimate: Task['timeEstimate']): number => (
    resolveTimeEstimateToMinutes(estimate, { enabled: timeEstimatesEnabled })
  );

  const findFreeSlotForDay = (day: Date, durationMinutes: number, excludeTaskId?: string): Date | null => (
    findCalendarFreeSlot(day, durationMinutes, {
      events: getExternalEventsForDate(day),
      excludeTaskId,
      tasks: schedulableTasks,
      timeEstimatesEnabled,
    })
  );

  const isSlotFreeForDay = (day: Date, startTime: Date, durationMinutes: number, excludeTaskId?: string): boolean => (
    isCalendarSlotFree(day, startTime, durationMinutes, {
      events: getExternalEventsForDate(day),
      excludeTaskId,
      tasks: schedulableTasks,
      timeEstimatesEnabled,
    })
  );

  const externalCalendarSettings = settings?.externalCalendars;

  const requestExternalCalendarRefresh = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastExternalRefreshRequestMsRef.current < EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS) return;
    lastExternalRefreshRequestMsRef.current = nowMs;
    setExternalRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setIsExternalLoading(true);
    setExternalError(null);
    if (loadedExternalRangeRef.current !== externalRangeKey) setExternalEvents([]);
    const rangeStart = new Date(externalRangeStartMs);
    const rangeEnd = new Date(externalRangeEndMs);

    fetchExternalCalendarEvents(rangeStart, rangeEnd, { signal: controller?.signal })
      .then(({ calendars, events }) => {
        if (cancelled) return;
        setExternalCalendars(calendars);
        loadedExternalRangeRef.current = externalRangeKey;
        setExternalEventsRange(externalRangeKey);
        setExternalEvents(events);
      })
      .catch((error) => {
        if (cancelled) return;
        logCalendarError(error);
        setExternalError(String(error));
        loadedExternalRangeRef.current = '';
        setExternalEventsRange('');
        setExternalEvents([]);
      })
      .finally(() => {
        if (cancelled) return;
        setIsExternalLoading(false);
      });

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [externalCalendarSettings, externalRangeEndMs, externalRangeStartMs, externalRangeKey, externalRefreshToken]);

  useFocusEffect(
    useCallback(() => {
      if (!hasHandledInitialFocusRef.current) {
        hasHandledInitialFocusRef.current = true;
        return undefined;
      }
      requestExternalCalendarRefresh();
      return undefined;
    }, [requestExternalCalendarRefresh]),
  );

  useEffect(() => {
    // The "now" tick only needs to run while the app is on screen: a
    // backgrounded calendar view has nothing rendering its current-time line
    // or day-keyed planning candidates, so ticking there just wakes the JS
    // thread for no visible effect.
    const startNowTick = () => {
      if (nowTickIntervalRef.current) return;
      setNowTick(Date.now());
      nowTickIntervalRef.current = setInterval(() => setNowTick(Date.now()), 60_000);
    };
    const stopNowTick = () => {
      if (!nowTickIntervalRef.current) return;
      clearInterval(nowTickIntervalRef.current);
      nowTickIntervalRef.current = null;
    };

    // iOS reports 'inactive' (not 'active') during a cold launch's initial
    // AppState read, so only treat 'background' as not-yet-active (correction #6).
    if (appStateRef.current !== 'background') startNowTick();

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (shouldRefreshExternalCalendarOnAppStateChange(appStateRef.current, nextAppState)) {
        requestExternalCalendarRefresh();
      }
      if (nextAppState === 'active') {
        startNowTick();
      } else {
        stopNowTick();
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
      stopNowTick();
    };
  }, [requestExternalCalendarRefresh]);

  const calendarNameById = useMemo(() => getCalendarSourceNames(externalCalendars), [externalCalendars]);
  const getSourceColorForId = useMemo(
    () => createCalendarSourceColorResolver(externalCalendars, themePreset),
    [externalCalendars, themePreset],
  );

  const planningTasks = useMemo(() => {
    if (!selectedDate) return [];
    return getCalendarPlanningTasks(areaVisibleTasks, {
      now: new Date(nowTick),
      prioritiesEnabled,
      projects,
      sections,
    });
    // Planning candidates recompute at most once per local day, not on every
    // minute tick: nowTick only sets the "now" instant used for date/sort
    // comparisons, mirrored from recurrenceProjectedAtIso above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaVisibleTasks, recurrenceProjectionDayKey, prioritiesEnabled, projects, sections, selectedDate]);

  const searchCandidates = useMemo(() => {
    if (!selectedDate) return [];
    return getCalendarSearchResults(visibleSchedulableTasks, scheduleQuery);
  }, [scheduleQuery, selectedDate, visibleSchedulableTasks]);

  const calendarComposerCandidates = useMemo(() => {
    if (!calendarComposer || calendarComposer.mode !== 'existing') return [];
    return getCalendarComposerCandidates(visibleSchedulableTasks, calendarComposer.query);
  }, [calendarComposer, visibleSchedulableTasks]);

  const calendarComposerSelectedTask = calendarComposer?.selectedTaskId
    ? tasks.find((task) => task.id === calendarComposer.selectedTaskId) ?? null
    : null;

  const composerDeps: CalendarComposerDeps = {
    findFreeSlot: findFreeSlotForDay,
    timeEstimateToMinutes,
  };

  const openedComposer = toCalendarViewComposer;

  const applyToComposer = (update: (state: CalendarTaskComposerState) => CalendarComposerState) => {
    setCalendarComposer((prev) => prev ? { ...prev, ...update(prev) } : prev);
  };

  const calendarComposerError = calendarComposer?.error ? getCalendarComposerErrorText(calendarComposer.error, t) : null;

  const failCalendarComposer = (error: CalendarComposerError) => {
    setCalendarComposer((prev) => prev ? { ...prev, error } : prev);
  };

  const openCalendarComposerAt = (start: Date, options?: { durationMinutes?: number; mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) ?? null : null;
    setCalendarComposer(openedComposer(openComposerAt(start, {
      durationMinutes: options?.durationMinutes,
      mode: options?.mode,
      task: selectedTask,
    }, composerDeps), start));
  };

  const openCalendarComposerForDate = (date: Date, options?: { mode?: CalendarTaskComposerMode; taskId?: string }) => {
    const selectedTask = options?.taskId ? tasks.find((task) => task.id === options.taskId) ?? null : null;
    setCalendarComposer(openedComposer(openComposerForDate(date, {
      mode: options?.mode,
      task: selectedTask,
    }, composerDeps), date));
  };

  const setCalendarComposerMode = (mode: CalendarTaskComposerMode) => {
    applyToComposer((prev) => setComposerMode(prev, mode));
  };

  const setCalendarComposerTitle = (title: string) => {
    applyToComposer((prev) => setComposerTitle(prev, title));
  };

  const setCalendarComposerQuery = (query: string) => {
    applyToComposer((prev) => setComposerQuery(prev, query));
  };

  const selectCalendarComposerTask = (task: Task) => {
    applyToComposer((prev) => selectComposerTask(prev, task, composerDeps));
  };

  const setCalendarComposerStartTime = (value: string) => {
    setCalendarComposer((prev) => prev ? setCalendarViewComposerStartTime(prev, value) : prev);
  };

  const setCalendarComposerDuration = (durationMinutes: number) => {
    applyToComposer((prev) => setComposerDuration(prev, durationMinutes));
  };

  const setCalendarComposerEndTime = (value: string) => {
    applyToComposer((prev) => setComposerEndTime(prev, value));
  };

  const closeCalendarComposer = () => setCalendarComposer(null);

  const saveCalendarComposer = async () => {
    if (!calendarComposer) return;
    const result = await executeComposerSave(calendarComposer, {
      areas,
      isSlotFree: (start, durationMinutes, excludeTaskId) => (
        isSlotFreeForDay(start, start, durationMinutes, excludeTaskId)
      ),
      parseOptions: quickAddParseOptions,
      projects,
    }, { addProject, addTask, updateTask });
    if (!result.success) {
      if (result.cause !== undefined) logCalendarError(result.cause);
      failCalendarComposer(result.error);
      return;
    }

    setCalendarComposer(null);
    setScheduleQuery('');
    setSelectedDate(result.start);
    setVisibleMonthDate(result.start);
    setPendingScrollMinutes((result.start.getHours() * 60 + result.start.getMinutes()) - DAY_START_HOUR * 60);
    setViewMode('day');
  };

  const scheduleTaskOnSelectedDate = (taskId: string) => {
    if (!selectedDate) return;
    const task = schedulableTasks.find((item) => item.id === taskId);
    if (!task) return;

    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    const slot = findFreeSlotForDay(selectedDate, durationMinutes, taskId);
    if (!slot) {
      showToast(getCalendarToasts(t).noFreeTime);
      return;
    }

    openCalendarComposerAt(slot, { durationMinutes, mode: 'existing', taskId });
  };

  const openQuickAddForDate = (date: Date) => {
    openCalendarComposerForDate(date, { mode: 'new' });
  };

  const openQuickAddAtDateTime = (date: Date) => {
    openCalendarComposerAt(date, { mode: 'new' });
  };

  const selectedDayKey = selectedDate ? calendarDateKey(selectedDate) : '';

  const getTimelineScrollY = useCallback((minutes: number) => getCalendarTimelineScrollYForMinutes({
    contentTop: viewModeRef.current === 'day' ? timelineContentTopRef.current : 0,
    minutes,
    pixelsPerMinute: PIXELS_PER_MINUTE,
  }), []);

  const rememberTimelineScrollY = useCallback((scrollY: number) => {
    timelineScrollOffsetRef.current = Math.max(0, scrollY);
    timelineAnchorMinutesRef.current = getCalendarTimelineAnchorMinutes({
      contentTop: viewModeRef.current === 'day' ? timelineContentTopRef.current : 0,
      dayMinutes: DAY_TIMELINE_MINUTES,
      pixelsPerMinute: PIXELS_PER_MINUTE,
      scrollY: timelineScrollOffsetRef.current,
    });
  }, []);

  const scrollTimelineToMinutes = useCallback((minutes: number, animated: boolean) => {
    const y = getTimelineScrollY(minutes);
    rememberTimelineScrollY(y);
    timelineScrollRef.current?.scrollTo({ y, animated });
  }, [getTimelineScrollY, rememberTimelineScrollY]);

  const handleTimelineScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    rememberTimelineScrollY(event.nativeEvent.contentOffset.y);
  }, [rememberTimelineScrollY]);

  const handleTimelineContentLayout = useCallback((event: LayoutChangeEvent) => {
    timelineContentTopRef.current = event.nativeEvent.layout.y;
  }, []);

  useEffect(() => {
    if (viewMode !== 'day' && viewMode !== 'week') return;
    if (viewMode === 'day' && !selectedDate) return;
    if (pendingScrollMinutes == null) return;

    const frame = requestAnimationFrame(() => {
      scrollTimelineToMinutes(pendingScrollMinutes, true);
      setPendingScrollMinutes(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingScrollMinutes, scrollTimelineToMinutes, selectedDate, viewMode]);

  useEffect(() => {
    // Runs after persisted view-mode/date restore above so day switches keep the user's previous timeline anchor.
    if (viewMode !== 'day' || !selectedDate || pendingScrollMinutes != null) return;
    if (lastDefaultTimelineScrollKeyRef.current !== 'day') return;
    if (lastDayTimelineRestoreKeyRef.current === selectedDayKey) return;

    lastDayTimelineRestoreKeyRef.current = selectedDayKey;
    const minutes = timelineAnchorMinutesRef.current;
    if (minutes == null) return;

    const frame = requestAnimationFrame(() => {
      scrollTimelineToMinutes(minutes, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingScrollMinutes, scrollTimelineToMinutes, selectedDate, selectedDayKey, viewMode]);

  useEffect(() => {
    if (!defaultTimelineScrollKey) {
      lastDefaultTimelineScrollKeyRef.current = '';
      return;
    }
    if (lastDefaultTimelineScrollKeyRef.current === defaultTimelineScrollKey) return;
    lastDefaultTimelineScrollKeyRef.current = defaultTimelineScrollKey;
    if (pendingScrollMinutes != null) return;

    const now = new Date();
    setPendingScrollMinutes((now.getHours() * 60 + now.getMinutes()) - DAY_START_HOUR * 60);
  }, [defaultTimelineScrollKey, pendingScrollMinutes]);

  const applyPeriod = (next: { selectedDate: Date | null; visibleMonthDate: Date }) => {
    setSelectedDate(next.selectedDate);
    setVisibleMonthDate(next.visibleMonthDate);
  };

  const moveCalendar = (move: CalendarPeriodMove) => {
    applyPeriod(moveCalendarPeriod({ viewMode, selectedDate, visibleMonthDate }, move, { calendarSystem }));
  };

  const shiftSelectedDate = (daysDelta: number) => {
    applyPeriod(shiftCalendarSelectedDate({ viewMode, selectedDate, visibleMonthDate }, daysDelta));
  };

  const handleToday = () => {
    const next = moveCalendarPeriod({ viewMode, selectedDate, visibleMonthDate }, 'today', { calendarSystem });
    applyPeriod(next);
    if ((viewMode === 'day' || viewMode === 'week') && next.selectedDate) {
      setPendingScrollMinutes((next.selectedDate.getHours() * 60 + next.selectedDate.getMinutes()) - DAY_START_HOUR * 60);
    }
  };

  const formatHourLabel = (hour: number) => formatCalendarHourLabel(hour, safeFormatDate);

  const getScheduleSlotLabel = (date: Date | null, task: Task) => {
    if (!date) return t('calendar.scheduleAction');
    const durationMinutes = timeEstimateToMinutes(task.timeEstimate);
    return getCalendarScheduleActionLabel(findFreeSlotForDay(date, durationMinutes, task.id), durationMinutes, { t, formatDate: safeFormatDate });
  };

  const commitTaskDrag = (taskId: string, dayStartMs: number, startMinutes: number, durationMinutes: number) => {
    const currentStart = safeParseDate(allTasks?.find((task) => task.id === taskId)?.startTime);
    const plan = planCalendarTaskMove({ taskId, dayStartMs, startMinutes, durationMinutes, currentStart, isSlotFree: isSlotFreeForDay });
    if (plan.kind === 'projected') return;
    if (plan.kind === 'conflict') {
      showToast(getCalendarToasts(t).timeConflict);
      return;
    }
    if (plan.updates.startTime === currentStart?.toISOString()) return;
    updateTask(taskId, plan.updates).catch(logCalendarError);
  };

  const setTimelineScrollEnabled = (enabled: boolean) => {
    const ref = timelineScrollRef.current as any;
    if (!ref?.setNativeProps) return;
    ref.setNativeProps({ scrollEnabled: enabled });
  };

  const markTaskDone = (taskId: string) => {
    updateTask(taskId, { ...CALENDAR_DONE_UPDATES }).catch(logCalendarError);
  };

  const openTaskActions = (taskId: string) => {
    const task = visibleTasks.find((item) => item.id === taskId);
    if (!task) return;
    const sheet = getCalendarTaskSheet(task, t);
    if (sheet.kind === 'projected') {
      Alert.alert(sheet.title, sheet.message, sheet.buttons.map((button) => ({ text: button.label })), { cancelable: true });
      return;
    }
    const onPress = {
      edit: () => setEditingTask(task),
      unschedule: () => updateTask(task.id, { ...CALENDAR_UNSCHEDULE_UPDATES }).catch(logCalendarError),
      done: () => markTaskDone(task.id),
      delete: () => deleteTask(task.id).catch(logCalendarError),
      cancel: undefined,
    };
    const buttons: AlertButton[] = sheet.buttons.map((button) => (
      button.style === 'default'
        ? { text: button.label, onPress: onPress[button.id] }
        : { text: button.label, style: button.style, ...(onPress[button.id] ? { onPress: onPress[button.id] } : {}) }
    ));
    Alert.alert(sheet.title, undefined, buttons, { cancelable: true });
  };

  const openExternalEventInCalendar = (event: ExternalCalendarEvent) => {
    openExternalCalendarEvent(event)
      .then((opened) => {
        if (opened) {
          if (Platform.OS === 'ios') {
            void logInfo('Native calendar event dialog completed', {
              scope: 'calendar',
              extra: { releaseCheck: 'v1.3.3/ios-external-calendar-open' },
            });
          }
          return;
        }
        showToast(getCalendarToasts(t).cannotOpenEvent);
      })
      .catch((error) => {
        logCalendarError(error);
        showToast(getCalendarToasts(t).openEventFailed);
      });
  };

  const createTaskFromExternalEvent = async (event: ExternalCalendarEvent) => {
    try {
      const plan = planCalendarEventTask(event, { calendarName: calendarNameById.get(event.sourceId), t });
      const result = await addTask(plan.title, plan.initialProps);
      if (!result.success) {
        showToast(getCalendarToasts(t).saveFailed(result.error));
        return;
      }

      if (plan.showDate) {
        setSelectedDate(plan.showDate);
        setVisibleMonthDate(plan.showDate);
      }
      showToast(getCalendarToasts(t).eventTaskCreated);
    } catch (error) {
      logCalendarError(error);
      showToast(getCalendarToasts(t).saveFailed());
    }
  };

  const openExternalEvent = (event: ExternalCalendarEvent) => {
    const sheet = getCalendarEventSheet(event, { canOpen: canOpenExternalCalendarEvent(event), t });
    const onPress = {
      createTask: () => {
        void createTaskFromExternalEvent(event);
      },
      openInCalendar: () => {
        // The iOS alert callback runs before its native dismissal finishes.
        if (Platform.OS === 'ios') setTimeout(() => openExternalEventInCalendar(event), 500);
        else openExternalEventInCalendar(event);
      },
    };
    const buttons: AlertButton[] = sheet.buttons.map((button) => (
      button.id === 'cancel'
        ? { text: button.label, style: 'cancel' }
        : { text: button.label, onPress: onPress[button.id] }
    ));
    Alert.alert(sheet.title, undefined, buttons, { cancelable: true });
  };

  const handlePrevMonth = () => moveCalendar('previous');

  const handleNextMonth = () => moveCalendar('next');

  const calendarDays = getCalendarMonthGrid(currentMonthDate, monthDates, weekStartIndex);

  const selectedDateExternalEvents = useMemo(
    () => (selectedDate ? getExternalEventsForDate(selectedDate) : []),
    [getExternalEventsForDate, selectedDate],
  );
  const selectedDateDeadlines = useMemo(
    () => (selectedDate ? getDeadlinesForDate(selectedDate) : []),
    [getDeadlinesForDate, selectedDate],
  );
  const selectedDateScheduled = useMemo(
    () => (selectedDate ? getScheduledForDate(selectedDate) : []),
    [getScheduledForDate, selectedDate],
  );
  const selectedDateTimedEvents = useMemo(
    () => selectedDateExternalEvents.filter((event) => !event.allDay),
    [selectedDateExternalEvents],
  );
  const selectedDayStart = useMemo(() => {
    if (!selectedDate) return null;
    const dayStart = new Date(selectedDate);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
    return dayStart;
  }, [selectedDate]);
  const selectedDayEnd = useMemo(() => {
    if (!selectedDate) return null;
    const dayEnd = new Date(selectedDate);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
    return dayEnd;
  }, [selectedDate]);
  const selectedDayMinutes = DAY_TIMELINE_MINUTES;
  const timelineHeight = selectedDayMinutes * PIXELS_PER_MINUTE;
  const selectedDayScheduledTasks = useMemo(
    () => getCalendarDayTimedTasks(selectedDateScheduled),
    [selectedDateScheduled],
  );
  const selectedDayNowTop = useMemo(() => {
    if (!selectedDate || !isToday(selectedDate)) return null;
    const minutes = getCalendarNowMinutes(new Date(nowTick));
    return minutes === null ? null : minutes * PIXELS_PER_MINUTE;
  }, [nowTick, selectedDate]);
  const {
    long: selectedDateLongLabel,
    planning: selectedDatePlanningLabel,
    dayTitle: selectedDayModeLabel,
  } = formatCalendarSelectedDateLabels(selectedDate, { dates: calendarDates, t });
  const scheduleSections = useMemo(
    () => getCalendarScheduleSections(selectedDate ?? currentMonthDate, getCalendarItemsForDate),
    [currentMonthDate, getCalendarItemsForDate, selectedDate],
  );

  const closeEditingTask = () => setEditingTask(null);
  const saveEditingTask = (taskId: string, updates: Partial<Task>) => updateTask(taskId, updates);

  return {
    DAY_END_HOUR,
    DAY_START_HOUR,
    PIXELS_PER_MINUTE,
    SNAP_MINUTES,
    calendarDays,
    calendarComposer,
    calendarComposerCandidates,
    calendarComposerError,
    calendarComposerSelectedTask,
    calendarDates,
    calendarSystem,
    calendarWeekVisibleDays,
    calendarNameById,
    closeCalendarComposer,
    closeEditingTask,
    commitTaskDrag,
    dayNames,
    editingTask,
    externalCalendars,
    externalError,
    formatHourLabel,
    getCalendarItemsForDate,
    getDayLists,
    getScheduleSlotLabel,
    handleNextMonth,
    handlePrevMonth,
    handleTimelineContentLayout,
    handleTimelineScroll,
    handleToday,
    isDark,
    isExternalLoading,
    isExternalEventOpenable: canOpenExternalCalendarEvent,
    isSameDay,
    isToday,
    locale,
    markTaskDone,
    monthLabel,
    planningTasks,
    openQuickAddAtDateTime,
    openQuickAddForDate,
    openExternalEvent,
    openTaskActions,
    saveEditingTask,
    scheduleQuery,
    scheduleTaskOnSelectedDate,
    searchCandidates,
    selectedDate,
    selectedDateDeadlines,
    selectedDateExternalEvents,
    selectedDateLongLabel,
    selectedDatePlanningLabel,
    selectedDateScheduled,
    selectedDateTimedEvents,
    selectedDayMinutes,
    selectedDayModeLabel,
    selectedDayNowTop,
    selectedDayScheduledTasks,
    selectedDayStart,
    selectedDayEnd,
    scheduleSections,
    saveCalendarComposer,
    selectCalendarComposerTask,
    setCalendarComposerDuration,
    setCalendarComposerEndTime,
    setCalendarComposerMode,
    setCalendarComposerQuery,
    setCalendarComposerStartTime,
    setCalendarComposerTitle,
    setCalendarWeekVisibleDays,
    showCompleted,
    toggleShowCompleted,
    setEditingTask,
    setScheduleQuery,
    setSelectedDate,
    setTimelineScrollEnabled,
    setViewMode,
    shiftSelectedDate,
    showToast,
    sourceColorForId: getSourceColorForId,
    t,
    tc,
    timeEstimateToMinutes,
    timelineHeight,
    timelineScrollRef,
    toRgba,
    updateTask,
    viewMode,
    weekDays,
    weekLabel,
  };
}
