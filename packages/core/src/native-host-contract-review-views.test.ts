import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import { resolveAreaFilterSelection } from './area-filter';
import {
    buildReviewSteps,
    getDailyReviewBuckets,
    getReviewOverviewGroups,
    getWeeklyReviewBuckets,
} from './review-utils';
import {
    decorateReviewOverviewGroups,
    getDailyReviewSettings,
    getReviewDay,
    getReviewOverviewSortBy,
    getReviewOverviewText,
    getWeeklyReviewLabels,
    titleWeeklyReviewSteps,
} from './review-views-model';
import { createReviewRecorder, loadReviewViewsFixture, seedReviewStore, type ReviewScenario } from './review-views-model.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { generateUUID } from './uuid';

const fixture = loadReviewViewsFixture();
const part = fixture.weeklyReview;
const scenario = (settings = 'base', extra: Partial<ReviewScenario> = {}): ReviewScenario => ({ name: 'contract', settings, actions: [], ...extra });
const page = { offset: 0, limit: 100 };
const ready = { status: 'ready' as const, events: part.calendarEvents };

describe('native host contract: Review, Weekly Review and Daily Review', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = part.timeZone;
        const english = await loadTranslations('en');
        t = (key) => english[key] ?? key;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    // Revisions read the clock.
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(part.now));
    };
    const openHost = async (entry = scenario(), saveData?: (data: unknown) => Promise<void>, data = part) => {
        const recorder = createReviewRecorder();
        await seedReviewStore(data, entry, recorder, { saveData });
        const host = createNativeHostContract();
        expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = 0;
        return { host, recorder };
    };
    const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };

    it('returns what core\'s review models return when called directly', async () => {
        freezeClock();
        const { host } = await openHost();
        const state = useTaskStore.getState();
        const now = new Date();

        const areas = sortAreasForDisplay(state.areas);
        const groups = decorateReviewOverviewGroups(getReviewOverviewGroups({
            tasks: state.tasks, projects: state.projects, orderedAreas: areas,
            areaFilter: resolveAreaFilterSelection(state.settings.filters, areas), sortBy: getReviewOverviewSortBy(state.settings),
        }), { areaById: new Map(areas.map((area) => [area.id, area])), unassignedAreaColor: state.settings.appearance?.unassignedAreaColor, text: getReviewOverviewText(t) });
        const overview = value(host.getReviewOverview({ expansionEdit: { type: 'cycle' }, ...page }));
        const everything = value(host.getReviewOverview({
            expandedAreaIds: overview.expandedAreaIds, expandedProjectIds: [], expansionEdit: { type: 'cycle' }, ...page,
        }));
        expect(everything.items.map((item) => (item.type === 'task' ? item.row.id : item.id)))
            .toEqual(groups.flatMap((group) => [group.id, ...group.projectGroups.flatMap((entry) => [entry.id, ...entry.tasks.map((task) => task.id)])]));
        // Rows carry core meta.
        const row = everything.items.find((item) => item.type === 'task');
        expect(row?.type === 'task' && row.row.meta).toBeTruthy();

        const labels = getWeeklyReviewLabels(t);
        const buckets = getWeeklyReviewBuckets(state.tasks, state.projects, { now });
        const steps = titleWeeklyReviewSteps(buildReviewSteps(buckets, { kind: 'weekly', externalCalendarDayCount: 0 }), labels);
        const weekly = value(host.getWeeklyReview({ ...page }));
        expect(weekly.rail.map((step) => [step.id, step.title])).toEqual(steps.map((step) => [step.id, step.title]));
        expect(weekly.items.map((item) => item.type === 'task' && item.row.id)).toEqual(buckets.inbox.map((task) => task.id));
        const someday = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'someday', startedAt: part.now }), ...page }));
        expect(someday.items.map((item) => item.type === 'task' && [item.row.id, item.scheduled])).toEqual([
            ...[...buckets.somedayGroups.due, ...buckets.somedayGroups.unscheduled].map((task) => [task.id, false]),
            ...buckets.somedayGroups.scheduled.map((task) => [task.id, true]),
        ]);

        const daily = value(host.getDailyReview({ checkpoint: JSON.stringify({ step: 'focus', startedAt: part.now }), ...page }));
        const dailyBuckets = getDailyReviewBuckets(state.tasks, state.projects, {
            now: getReviewDay(now), sortBy: getDailyReviewSettings(state.settings).sortBy, sections: state.sections,
        });
        expect(daily.step.id).toBe('focus');
        expect(daily.items.map((item) => [item.row.id, item.showFocusToggle])).toEqual(dailyBuckets.focusCandidates.map((task) => [task.id, true]));
    });

    it('offers an opt-in due scope and saves mark-reviewed once across retry', async () => {
        freezeClock();
        const data = { ...part, tasks: part.tasks.map((task) => ({
            ...task, reviewAt: task.id === 'n-launch' ? '2026-09-23' : '2099-01-01',
        })) };
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData, data);
        const due = value(host.getReviewOverview({ scope: 'due', selectedIds: ['n-demo'], ...page }));
        expect(due.scope).toMatchObject({ selected: 'due', options: [{ id: 'due' }, { id: 'all' }] });
        expect(due.bulk).toBeNull();
        expect(due.empty).toBeNull();

        const input = { requestId: generateUUID(), action: { type: 'markReviewedTasks' as const, taskIds: ['n-launch'] } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runReviewAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(recorder.log).toEqual([['batchUpdateTasks', [{ id: 'n-launch', updates: { reviewAt: '<undefined>' } }]]]);
        saveData.mockResolvedValue(undefined);
        expect(value(await host.runReviewAction(input))).toMatchObject({ changed: true });
        expect(recorder.log).toHaveLength(1);
        expect(value(host.getReviewOverview({ scope: 'due', ...page })).empty).toBe(t('review.dueEmpty'));
        expect(value(host.getReviewOverview({ scope: 'all', ...page })).empty).toBeNull();
        expect(value(await host.runReviewAction({ ...input, requestId: generateUUID() }))).toMatchObject({ changed: false });
    });

    it('uses the singular task unit for a Daily Review count of one', async () => {
        freezeClock();
        const { host } = await openHost(scenario(), undefined, { ...part,
            tasks: part.tasks.filter((task, index, tasks) => task.status !== 'inbox'
                || tasks.findIndex((candidate) => candidate.status === 'inbox') === index) });
        const daily = value(host.getDailyReview({ checkpoint: JSON.stringify({ step: 'inbox', startedAt: part.now }), calendar: ready, ...page }));
        expect(daily.content.step).toBe('inbox');
        if (daily.content.step !== 'inbox') return;
        expect(daily.content.count).toBe(1);
        expect(daily.content.unit).toBe('task');
    });

    it('moves through the Weekly Review by checkpoints and resumes where it stopped', async () => {
        freezeClock();
        const { host } = await openHost();
        const first = value(host.getWeeklyReview({ checkpoint: null, calendar: ready, ...page }));
        expect(first).toMatchObject({ resumed: false, step: { id: 'inbox', indicator: '1/8' }, back: { checkpoint: null }, finish: null });
        const second = value(host.getWeeklyReview({ checkpoint: first.next!.checkpoint, calendar: ready, ...page }));
        expect(second).toMatchObject({ resumed: true, step: { id: 'stale' }, back: { checkpoint: first.checkpoint } });
        // A paused review resumes from what the host stored.
        const resumed = value(host.getWeeklyReview({ checkpoint: second.checkpoint, calendar: ready, ...page }));
        expect(resumed.step.id).toBe('stale');
        const last = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'completed', startedAt: part.now }), ...page }));
        expect(last).toMatchObject({ next: null, finish: { lastReviewKey: 'lastWeeklyReview', lastReviewAt: part.now } });
        // A checkpoint from last week starts over.
        const stale = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'projects', startedAt: '2026-09-18T13:00:00.000Z' }), ...page }));
        expect(stale).toMatchObject({ resumed: false, step: { id: 'inbox' } });
    });

    it('formats review dates with the user\'s language', async () => {
        freezeClock();
        const { host } = await openHost();
        expect(await host.setLanguage({ storedLanguage: 'fr', systemLocale: null })).toMatchObject({ ok: true });
        const view = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'calendar', startedAt: part.now }), calendar: ready, ...page }));
        const formatDate = createDateFormatter({ language: 'fr', systemLocale: null });
        expect(view.content.step === 'calendar' && view.content.days[0].title).toBe(`${formatDate(new Date(2026, 8, 23), 'EEEE, PP')} · 2`);
        const daily = value(host.getDailyReview({ calendar: ready, ...page }));
        expect(daily.content.step === 'today' && daily.content.calendar.days[0].title).toBe(`${formatDate(new Date(2026, 8, 23), 'P')} · ${daily.content.calendar.label}`);
    });

    it('pages within one revision and refuses a stale page after an edit', async () => {
        freezeClock();
        const { host } = await openHost();
        const everything = { expandedAreaIds: ['area:none', 'area:a-work', 'area:a-home', 'area:a-side'] };
        const first = value(host.getReviewOverview({ ...everything, expansionEdit: { type: 'cycle' }, offset: 0, limit: 3 }));
        const expanded = { expandedAreaIds: first.expandedAreaIds, expandedProjectIds: first.expandedProjectIds };
        const again = value(host.getReviewOverview({ ...expanded, offset: 0, limit: 3 }));
        expect(again.revision).toBe(first.revision);
        expect(value(host.getReviewOverview({ ...expanded, offset: 3, limit: 3, revision: first.revision })).items).toHaveLength(3);
        expect(host.getReviewOverview({ ...expanded, offset: 3, limit: 3 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const weekly = value(host.getWeeklyReview({ offset: 0, limit: 1 }));
        const daily = value(host.getDailyReview({ offset: 0, limit: 1 }));

        await useTaskStore.getState().updateTask('i-thought', { title: 'Inbox idea' });
        expect(host.getReviewOverview({ ...expanded, offset: 3, limit: 3, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getWeeklyReview({ offset: 1, limit: 1, revision: weekly.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getDailyReview({ offset: 1, limit: 1, revision: daily.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(value(host.getReviewOverview({ ...expanded, offset: 0, limit: 3 })).revision).not.toBe(first.revision);
        // A setting the review reads changes the revision too.
        await useTaskStore.getState().updateSettings({ gtd: { weeklyReview: { includeContextStep: false } } });
        const noContexts = value(host.getWeeklyReview({ offset: 0, limit: 1 }));
        expect(noContexts.revision).not.toBe(weekly.revision);
        expect(noContexts.rail.map((step) => step.id)).not.toContain('contexts');
    });

    it('retries a failed bulk move exactly: one write, and the retry finishes the save', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData);
        const input = { requestId: generateUUID(), action: { type: 'moveTasks' as const, taskIds: ['n-launch', 'n-demo'], status: 'waiting' as const } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runReviewAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        const writes = recorder.log.length;
        expect(recorder.log[0]).toEqual(['batchMoveTasks', ['n-launch', 'n-demo'], 'waiting']);

        saveData.mockResolvedValue(undefined);
        const retried = value(await host.runReviewAction(input));
        expect(retried).toEqual({ changed: true, toast: { tone: 'success', title: 'Done', message: '2 tasks', undo: null }, createdId: null });
        expect(recorder.log).toHaveLength(writes);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[] };
        expect(saved.tasks.filter(({ id }) => id === 'n-launch' || id === 'n-demo').map((task) => task.status)).toEqual(['waiting', 'waiting']);
        // A lost reply repeats the request: no write, no save.
        const saves = saveData.mock.calls.length;
        expect(value(await host.runReviewAction(input))).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.runReviewAction({ ...input, action: { ...input.action, status: 'next' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('retries a failed project Add task exactly: one task', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host } = await openHost(scenario(), saveData);
        const input = { requestId: generateUUID(), action: { type: 'addProjectTask' as const, projectId: 'p-garden', title: 'Buy bulbs @garden' } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runReviewAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = value(await host.runReviewAction(input));
        expect(retried).toEqual({ changed: true, toast: null, createdId: input.requestId.toLowerCase() });
        const created = useTaskStore.getState()._allTasks.filter((task) => task.projectId === 'p-garden' && task.title === 'Buy bulbs');
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ id: input.requestId.toLowerCase(), status: 'next', contexts: ['@garden'] });
    });

    it('follows up a waiting item as target state, and undoes a delete from its toast', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const followUp = { requestId: generateUUID(), action: { type: 'followUpToday' as const, taskId: 'w-vendor' } };
        expect(value(await host.runReviewAction(followUp))).toMatchObject({ changed: true });
        expect(recorder.log).toEqual([['updateTask', 'w-vendor', { reviewAt: '2026-09-23' }]]);
        // Already due for review: nothing to write, even for a new request.
        expect(value(await host.runReviewAction({ ...followUp, requestId: generateUUID() }))).toMatchObject({ changed: false });
        expect(recorder.log).toHaveLength(1);

        const trashed = value(await host.runReviewAction({ requestId: generateUUID(), action: { type: 'trashTasks', taskIds: ['i-thought', 'n-bike'] } }));
        expect(trashed.toast).toMatchObject({ message: '2 tasks', undo: { label: 'Undo', action: { type: 'restoreTasks', taskIds: ['i-thought', 'n-bike'] } } });
        value(await host.runReviewAction({ requestId: generateUUID(), action: trashed.toast!.undo!.action }));
        expect(['i-thought', 'n-bike'].map((id) => useTaskStore.getState()._tasksById.get(id)?.deletedAt)).toEqual([undefined, undefined]);
    });

    it('retries a status change whose store save failed after it landed: one write', async () => {
        freezeClock();
        // Reopening a task of an archived project reactivates the project and saves at once.
        const archivedAt = '2026-09-08T09:00:00.000Z';
        const data = {
            ...part,
            tasks: [...part.tasks, {
                id: 'd-reopen', title: 'Reopen me', status: 'done' as const, completedAt: archivedAt, statusBeforeProjectArchive: 'next' as const,
                projectArchivedAt: archivedAt, projectId: 'p-shelved', contexts: [], tags: [], createdAt: archivedAt, updatedAt: archivedAt, rev: 2,
            }],
            projects: [...part.projects, {
                id: 'p-shelved', title: 'Shelved', status: 'archived' as const, color: '#94a3b8', order: 9, tagIds: [],
                createdAt: archivedAt, updatedAt: archivedAt, rev: 2,
            }],
        };
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(scenario(), saveData, data);
        const input = { requestId: generateUUID(), action: { type: 'setTaskStatus' as const, taskId: 'd-reopen', status: 'next' as const } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runReviewAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState()._projectsById.get('p-shelved')?.status).toBe('active');
        saveData.mockResolvedValue(undefined);
        expect(value(await host.runReviewAction(input))).toEqual({ changed: true, toast: null, createdId: null });
        expect(recorder.log).toEqual([['updateTask', 'd-reopen', { status: 'next' }]]);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[]; projects: { id: string; status: string }[] };
        expect(saved.tasks.find(({ id }) => id === 'd-reopen')?.status).toBe('next');
        expect(saved.projects.find(({ id }) => id === 'p-shelved')?.status).toBe('active');
    });

    it('writes nothing when a request that already landed is replayed after a restart', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const run = (target: typeof host, requestId: string, action: unknown) => target.runReviewAction({ requestId, action: action as never });
        const actions: [string, unknown][] = [
            [generateUUID(), { type: 'moveTasks', taskIds: ['n-launch', 'n-demo'], status: 'waiting' }],
            [generateUUID(), { type: 'trashTasks', taskIds: ['i-thought', 'n-bike'] }],
            [generateUUID(), { type: 'setTaskStatus', taskId: 'n-cv', status: 'someday' }],
            [generateUUID(), { type: 'addTag', taskIds: ['n-logo'], tag: '#design' }],
            [generateUUID(), { type: 'organizeTasks', taskIds: ['n-rent'], input: { areaId: 'a-home', tags: ['#bills'] } }],
            [generateUUID(), { type: 'followUpToday', taskId: 'w-vendor' }],
            [generateUUID(), { type: 'trashTask', taskId: 'n-orphan' }],
        ];
        for (const [requestId, action] of actions) expect(value(await run(host, requestId, action))).toMatchObject({ changed: true });
        const writes = recorder.log.length;
        const revisions = () => useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev]);
        const before = revisions();
        // A new host has no receipts, as after a restart: every replay finds its target state.
        const restarted = createNativeHostContract();
        expect(await restarted.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        recorder.log.length = writes;
        for (const [requestId, action] of actions) {
            expect(value(await run(restarted, requestId, action))).toEqual({ changed: false, toast: null, createdId: null });
        }
        expect(recorder.log).toHaveLength(writes);
        expect(revisions()).toEqual(before);
        // Restoring what is already live writes nothing either.
        expect(value(await run(restarted, generateUUID(), { type: 'restoreTasks', taskIds: ['i-thought', 'n-bike'] }))).toMatchObject({ changed: true });
        expect(value(await run(restarted, generateUUID(), { type: 'restoreTasks', taskIds: ['i-thought', 'n-bike'] }))).toMatchObject({ changed: false });
    });

    it('answers a replayed project Add task with its task, and refuses a request ID another task holds', async () => {
        freezeClock();
        const { host } = await openHost();
        const input = { requestId: generateUUID(), action: { type: 'addProjectTask' as const, projectId: 'p-garden', title: 'Buy bulbs @garden' } };
        const created = value(await host.runReviewAction(input));
        const restarted = createNativeHostContract();
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        expect(value(await restarted.runReviewAction(input))).toEqual({ changed: false, toast: null, createdId: created.createdId });
        expect(await restarted.runReviewAction({ ...input, action: { ...input.action, title: 'Something else' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // An unrelated task under the request's ID is never taken for this request's result.
        const taken = generateUUID();
        value(await restarted.runReviewAction({ requestId: taken, action: { type: 'addProjectTask', projectId: 'p-launch', title: 'Unrelated' } }));
        const again = createNativeHostContract();
        expect(await again.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        expect(await again.runReviewAction({ requestId: taken, action: input.action })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        await useTaskStore.getState().deleteTask(taken.toLowerCase());
        expect(await again.runReviewAction({ requestId: taken, action: { type: 'addProjectTask', projectId: 'p-launch', title: 'Unrelated' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks.filter((task) => task.title === 'Buy bulbs')).toHaveLength(1);
    });

    it('pages the Weekly Review\'s nested lists and AI items under the view\'s revision', async () => {
        freezeClock();
        const old = '2026-08-01T12:00:00.000Z';
        const bulk = Array.from({ length: 101 }, (_, index) => ({
            id: `bulk-${index}`, title: `Bulk ${String(index).padStart(3, '0')}`, status: 'next' as const, contexts: ['@bulk'], tags: [],
            createdAt: old, updatedAt: old,
        }));
        const stale = Array.from({ length: 101 }, (_, index) => ({
            id: `old-${index}`, title: `Old ${index}`, status: 'active' as const, color: '#94a3b8', order: 10 + index, tagIds: [],
            createdAt: old, updatedAt: old,
        }));
        const events = Array.from({ length: 101 }, (_, index) => ({
            id: `ev-${index}`, sourceId: 'cal', title: `Event ${index}`, allDay: false,
            start: `2026-09-25T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
            end: '2026-09-25T20:00:00.000Z',
        }));
        const { host } = await openHost(scenario('ai'), undefined, { ...part, tasks: [...part.tasks, ...bulk], projects: [...part.projects, ...stale] });
        const calendar = { status: 'ready' as const, events };
        const at = (step: string) => JSON.stringify({ step, startedAt: part.now });
        const readAll = (inputs: Record<string, unknown>, revision: string, list: string, total: number, key?: string) => {
            const items: unknown[] = [];
            while (items.length < total) {
                items.push(...value(host.getWeeklyReviewList({ ...inputs, list: list as never, key, offset: items.length, limit: 100, revision })).items);
            }
            return items;
        };

        const staleInputs = { checkpoint: at('stale'), calendar };
        const staleView = value(host.getWeeklyReview({ ...staleInputs, offset: 0, limit: 1 }));
        if (staleView.content.step !== 'stale') throw new Error('Expected the stale step');
        expect(staleView.content.projects).toMatchObject({ total: 102 });
        expect(staleView.content.projects.items).toHaveLength(100);
        expect(staleView.content.ai.items.total).toBeGreaterThan(200);
        expect(staleView.content.ai.items.items).toHaveLength(100);
        const aiItems = readAll(staleInputs, staleView.revision, 'aiItems', staleView.content.ai.items.total);
        expect(new Set(aiItems.map((item) => (item as { id: string }).id)).size).toBe(staleView.content.ai.items.total);
        expect(readAll(staleInputs, staleView.revision, 'staleProjects', 102)).toHaveLength(102);

        const contextInputs = { checkpoint: at('contexts'), calendar };
        const contexts = value(host.getWeeklyReview({ ...contextInputs, offset: 0, limit: 100 }));
        const bulkCard = contexts.items.find((item) => item.type === 'context' && item.context === '@bulk');
        expect(bulkCard?.type === 'context' && [bulkCard.tasks.total, bulkCard.tasks.items.length]).toEqual([101, 100]);
        const bulkTasks = readAll(contextInputs, contexts.revision, 'contextTasks', 101, '@bulk') as { title: string }[];
        expect(bulkTasks[bulkTasks.length - 1].title).toBe('Bulk 100');

        const calendarInputs = { checkpoint: at('calendar'), calendar };
        const calendarView = value(host.getWeeklyReview({ ...calendarInputs, offset: 0, limit: 1 }));
        if (calendarView.content.step !== 'calendar') throw new Error('Expected the calendar step');
        const busy = calendarView.content.days.find((day) => day.events.total === 101)!;
        expect(busy.events.items).toHaveLength(100);
        expect(readAll(calendarInputs, calendarView.revision, 'dayEvents', 101, busy.key)).toHaveLength(101);

        // A list of another step, or a stale revision, is refused.
        expect(host.getWeeklyReviewList({ ...calendarInputs, list: 'aiItems', offset: 0, limit: 10, revision: calendarView.revision }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        await useTaskStore.getState().updateTask('bulk-0', { title: 'Renamed' });
        expect(host.getWeeklyReviewList({ ...contextInputs, list: 'contextTasks', key: '@bulk', offset: 100, limit: 10, revision: contexts.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('refuses invalid input', async () => {
        freezeClock();
        const { host } = await openHost();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getReviewOverview({ offset: 0, limit: 101 })).toMatchObject(invalid);
        expect(host.getReviewOverview({ expansionEdit: { type: 'explode' } as never, ...page })).toMatchObject(invalid);
        expect(host.getWeeklyReview({ calendar: { status: 'ready', events: [{ id: 1 }] } as never, ...page })).toMatchObject(invalid);
        expect(host.getDailyReview({ checkpoint: 42 as never, ...page })).toMatchObject(invalid);
        const run = (action: unknown) => host.runReviewAction({ requestId: generateUUID(), action: action as never });
        expect(await host.runReviewAction({ requestId: 'not-a-uuid', action: { type: 'trashTask', taskId: 'i-thought' } })).toMatchObject(invalid);
        expect(await run({ type: 'moveTasks', taskIds: ['i-thought'], status: 'archived' })).toMatchObject(invalid);
        expect(await run({ type: 'organizeTasks', taskIds: ['i-thought'], input: { areaId: 'no-such-area' } })).toMatchObject(invalid);
        expect(await run({ type: 'organizeTasks', taskIds: ['i-thought'], input: { dueDate: 'soon' } })).toMatchObject(invalid);
        expect(await run({ type: 'addProjectTask', projectId: 'p-garden', title: '   ' })).toMatchObject(invalid);
        expect(await run({ type: 'applySuggestions', suggestions: [{ id: 'n-bike', action: 'delete', reason: '' }] })).toMatchObject(invalid);
        expect(await run({ type: 'setTaskStatus', taskId: 'missing', status: 'next' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'purgeEverything' })).toMatchObject(invalid);
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        expect(host.getReviewOverview(page)).toMatchObject(notReady);
        expect(host.getWeeklyReview(page)).toMatchObject(notReady);
        expect(host.getDailyReview(page)).toMatchObject(notReady);
        expect(host.getWeeklyReviewList({ list: 'aiItems', offset: 0, limit: 10, revision: 'r' })).toMatchObject(notReady);
        expect(await host.runReviewAction({ requestId: generateUUID(), action: { type: 'trashTask', taskId: 'i-thought' } })).toMatchObject(notReady);
    });
});
