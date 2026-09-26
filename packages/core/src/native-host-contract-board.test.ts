import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import {
    buildBoardColumns,
    getBoardCard,
    getBoardFilterOptions,
    getBoardProjectBadges,
    resolveBoardFilterState,
    selectBoardTasks,
    EMPTY_BOARD_FILTER_STATE,
} from './board-view-model';
import { createBoardRecorder, loadBoardViewsFixture, seedBoardStore, type BoardFixturePart } from './board-view-model.replay';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, sortAreasForDisplay } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { generateUUID } from './uuid';

const part = loadBoardViewsFixture().board;
const scenario = (settings = 'base') => ({ name: 'contract', settings, actions: [] });

describe('native host contract: Board', () => {
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
    const openHost = async (saveData?: (data: unknown) => Promise<void>, data: BoardFixturePart = part) => {
        const recorder = createBoardRecorder();
        await seedBoardStore(data, scenario(), recorder, { saveData });
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
    /** The Board as core's model builds it straight from the store. */
    const direct = (filters = EMPTY_BOARD_FILTER_STATE) => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        const areaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
        const tasks = selectBoardTasks(state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter: areaFilter })));
        const badges = getBoardProjectBadges(state.projects, areaById);
        const options = getBoardFilterOptions({ tasks, projects: state.projects, areaFilter, areaById, badges, t });
        const { criteria } = resolveBoardFilterState(filters, {
            tokens: options.tokens, projectIds: options.projects.map((project) => project.id), getProjectLabel: options.getProjectLabel, t,
        });
        return { columns: buildBoardColumns({ tasks, criteria, searchQuery: filters.searchQuery, projects: state.projects, now: new Date(), t }), badges, options };
    };

    it('returns what core\'s Board model returns when called directly, with core meta on every card', async () => {
        freezeClock();
        const { host } = await openHost();
        for (const filters of [EMPTY_BOARD_FILTER_STATE, { ...EMPTY_BOARD_FILTER_STATE, tokens: ['@computer', '@home'], searchQuery: 'a', duePreset: 'overdue' as const }]) {
            const expected = direct(filters);
            const view = value(host.getBoardView({ filters, limit: 100 }));
            expect(view.columns.map((column) => [column.status, column.label, column.tone, column.count, column.empty, column.cards.map((card) => card.row.id)]))
                .toEqual(expected.columns.map((column) => [column.status, column.label, column.tone, column.tasks.length, column.empty, column.tasks.map((task) => task.id)]));
            for (const [index, column] of expected.columns.entries()) {
                expect(view.columns[index].cards.map((card) => card.card))
                    .toEqual(column.tasks.map((task) => getBoardCard(task, { badges: expected.badges, timeEstimatesEnabled: true, t })));
                for (const card of view.columns[index].cards) expect(card.row.meta.parts).toBeInstanceOf(Array);
            }
            expect(view.sheet.tokens.items.map((token) => token.value)).toEqual(expected.options.tokens);
            expect(view.sheet.projects.items.map(({ id, title }) => ({ id, title }))).toEqual(expected.options.projects);
        }
    });

    it('speaks the host language', async () => {
        freezeClock();
        const { host } = await openHost();
        expect(await host.setLanguage({ storedLanguage: 'fr', systemLocale: null })).toMatchObject({ ok: true });
        const french = await loadTranslations('fr');
        const view = value(host.getBoardView({ limit: 1 }));
        expect(view.columns.map((column) => column.label)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done'].map((status) => french[`status.${status}`]));
        expect(view.columns[3].empty).toBe(french['board.noTasks']);
        expect(view.cardActions.swipes.right.label).toBe(french['board.delete']);
    });

    it('formats custom Board estimates in the host language', async () => {
        freezeClock();
        const { host } = await openHost();
        expect(await host.setLanguage({ storedLanguage: 'ko', systemLocale: null })).toMatchObject({ ok: true });
        const cards = value(host.getBoardView({ limit: 100 })).columns.flatMap((column) => column.cards);
        expect(cards.find((entry) => entry.row.id === 'n-bulbs')?.card.timeEstimateLabel).toBe('45분');
        expect(cards.find((entry) => entry.row.id === 'n-demo')?.card.timeEstimateLabel).toBe('1시간');
    });

    it('pages a long column and the sheet under one revision, and refuses a stale page after a relevant edit', async () => {
        freezeClock();
        const old = '2026-08-01T12:00:00.000Z';
        const bulk = Array.from({ length: 150 }, (_, index) => ({
            id: `bulk-${index}`, title: `Bulk ${index}`, status: 'someday' as const, contexts: [`@bulk${index}`], tags: [], createdAt: old, updatedAt: old,
        }));
        const { host } = await openHost(undefined, { ...part, tasks: [...part.tasks, ...bulk] });
        const view = value(host.getBoardView({ limit: 100 }));
        const someday = view.columns.find((column) => column.status === 'someday')!;
        expect([someday.count, someday.cards.length]).toEqual([150, 100]);
        expect([view.sheet.tokens.total, view.sheet.tokens.items.length]).toEqual([169, 100]);
        const rest = value(host.getBoardList({ list: 'cards', status: 'someday', offset: 100, limit: 100, revision: view.revision }));
        expect(rest.items.map((card) => (card as { row: { id: string } }).row.id)).toEqual(bulk.slice(100).map((task) => task.id));
        expect(value(host.getBoardList({ list: 'tokens', offset: 100, limit: 100, revision: view.revision })).items).toHaveLength(69);
        // The sheet's chips page too: 150 selected tokens.
        const filters = { tokens: bulk.slice(0, 100).map((task) => task.contexts[0]), excludedTokens: bulk.slice(100).map((task) => task.contexts[0]) };
        const filtered = value(host.getBoardView({ filters, limit: 1 }));
        expect([filtered.sheet.chips.total, filtered.sheet.chips.items.length]).toEqual([150, 100]);
        const moreChips = value(host.getBoardList({ filters: filtered.filters, list: 'chips', offset: 100, limit: 100, revision: filtered.revision }));
        expect(moreChips.items).toEqual(bulk.slice(100).map((task) => ({
            id: `excluded-token:${task.contexts[0]}`, label: task.contexts[0], excluded: true, edit: { type: 'removeToken', value: task.contexts[0] },
        })));
        // Filters name their own revision.
        expect(value(host.getBoardView({ filters: { searchQuery: 'bulk 1' }, limit: 1 })).revision).not.toBe(view.revision);

        await useTaskStore.getState().updateTask('bulk-0', { title: 'Renamed' });
        expect(host.getBoardList({ list: 'cards', status: 'someday', offset: 100, limit: 100, revision: view.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const renamed = value(host.getBoardView({ limit: 100 }));
        expect(renamed.revision).not.toBe(view.revision);
        // A setting the cards read changes the revision too.
        await useTaskStore.getState().updateSettings({ features: { timeEstimates: false } });
        const noEstimates = value(host.getBoardView({ limit: 100 }));
        expect(noEstimates.revision).not.toBe(renamed.revision);
        expect(noEstimates.columns[1].cards.every((card) => card.card.timeEstimateLabel === null)).toBe(true);
    });

    it('retries a failed move exactly: one write, and the retry finishes the save', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(saveData);
        const input = { requestId: generateUUID(), action: { type: 'moveCard' as const, taskId: 'n-rent', status: 'waiting' as const } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runBoardAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(recorder.log).toEqual([['updateTask', 'n-rent', { status: 'waiting' }]]);

        saveData.mockResolvedValue(undefined);
        expect(value(await host.runBoardAction(input))).toEqual({ changed: true, open: null });
        expect(recorder.log).toHaveLength(1);
        const saved = saveData.mock.lastCall?.[0] as { tasks: { id: string; status: string }[] };
        expect(saved.tasks.find(({ id }) => id === 'n-rent')?.status).toBe('waiting');
        // A lost reply repeats the request: no write, no save.
        const saves = saveData.mock.calls.length;
        expect(value(await host.runBoardAction(input))).toEqual({ changed: true, open: null });
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(await host.runBoardAction({ ...input, action: { ...input.action, status: 'someday' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('retries a failed duplicate exactly: one copy, opened by the retry', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(saveData);
        const input = { requestId: generateUUID(), action: { type: 'duplicateTask' as const, taskId: 'n-draft' } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.runBoardAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        saveData.mockResolvedValue(undefined);
        const retried = value(await host.runBoardAction(input));
        expect(recorder.log).toEqual([['duplicateTask', 'n-draft', false]]);
        const copies = useTaskStore.getState().tasks.filter((task) => task.title === 'Draft launch post' && task.id !== 'n-draft');
        expect(copies).toHaveLength(1);
        expect(retried).toEqual({ changed: true, open: { taskId: copies[0].id, projectId: 'p-launch', tab: 'task' } });
    });

    it('replays a duplicate after restart without a second copy and refuses a different source', async () => {
        freezeClock();
        const { host } = await openHost();
        const requestId = generateUUID();
        const action = { type: 'duplicateTask' as const, taskId: 'n-draft' };
        const first = value(await host.runBoardAction({ requestId, action }));
        expect(first).toMatchObject({ changed: true, open: { taskId: requestId } });
        const before = useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev]);
        const restarted = createNativeHostContract();
        expect(await restarted.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        expect(value(await restarted.runBoardAction({ requestId, action }))).toEqual({ changed: false, open: first.open });
        expect(await restarted.runBoardAction({ requestId, action: { ...action, taskId: 'n-demo' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev])).toEqual(before);
        await useTaskStore.getState().updateTask(requestId, { title: 'Edited copy' });
        await flushPendingSave();
        const editedRestart = createNativeHostContract();
        expect(await editedRestart.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        expect(await editedRestart.runBoardAction({ requestId, action }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('replays a requested duplicate after restart with an older identical copy', async () => {
        freezeClock();
        const { host } = await openHost();
        expect((await useTaskStore.getState().duplicateTask('n-draft', false)).success).toBe(true);
        await flushPendingSave();
        const requestId = generateUUID();
        const action = { type: 'duplicateTask' as const, taskId: 'n-draft' };
        expect(value(await host.runBoardAction({ requestId, action }))).toMatchObject({ changed: true, open: { taskId: requestId } });
        const before = useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev]);
        const restarted = createNativeHostContract();
        expect(await restarted.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        expect(value(await restarted.runBoardAction({ requestId, action }))).toMatchObject({ changed: false, open: { taskId: requestId } });
        expect(useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev])).toEqual(before);
    });

    it('writes nothing when a move or a delete that already landed is replayed after a restart', async () => {
        freezeClock();
        const { host, recorder } = await openHost();
        const actions: [string, unknown][] = [
            [generateUUID(), { type: 'moveCard', taskId: 'n-rent', status: 'waiting' }],
            [generateUUID(), { type: 'moveCard', taskId: 'w-alice', status: 'someday' }],
            [generateUUID(), { type: 'moveCard', taskId: 'n-loose', status: 'next', afterId: null }],
            [generateUUID(), { type: 'moveCard', taskId: 'n-demo', status: 'next', afterId: 'n-gone' }],
            // Under a search: the card lands after one the search shows.
            [generateUUID(), { type: 'moveCard', taskId: 'w-vendor', status: 'waiting', afterId: 'n-rent', filters: { searchQuery: 'e' } }],
            [generateUUID(), { type: 'trashTask', taskId: 'n-bulbs' }],
        ];
        const run = (target: typeof host, requestId: string, action: unknown) => target.runBoardAction({ requestId, action: action as never });
        for (const [requestId, action] of actions) expect(value(await run(host, requestId, action))).toMatchObject({ changed: true });
        const writes = recorder.log.length;
        const revisions = () => useTaskStore.getState()._allTasks.map((task) => [task.id, task.rev, task.status, task.boardOrder]);
        const before = revisions();
        // A new host has no receipts, as after a restart: every replay finds its target state.
        const restarted = createNativeHostContract();
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        for (const [requestId, action] of actions) {
            expect(value(await run(restarted, requestId, action))).toEqual({ changed: false, open: null });
        }
        expect(recorder.log).toHaveLength(writes);
        expect(revisions()).toEqual(before);
    });

    it('writes a reorder when unordered cards move in the Board order', async () => {
        freezeClock();
        // Two cards without a board order: the Board shows them in list order, the store
        // orders them by creation. Moving B above A asks for the store's own order.
        const card = (id: string, createdAt: string) => ({ id, title: id, status: 'someday' as const, contexts: [], tags: [], createdAt, updatedAt: createdAt });
        const { host, recorder } = await openHost(undefined, { ...part, tasks: [...part.tasks, card('A', '2026-09-20T12:00:00.000Z'), card('B', '2026-09-10T12:00:00.000Z')] });
        const someday = () => value(host.getBoardView({ limit: 10 })).columns.find((column) => column.status === 'someday')!.cards.map((entry) => entry.row.id);
        expect(someday()).toEqual(['A', 'B']);
        expect(value(await host.runBoardAction({ requestId: generateUUID(), action: { type: 'moveCard', taskId: 'B', status: 'someday', afterId: null } })))
            .toEqual({ changed: true, open: null });
        expect(recorder.log).toEqual([['reorderBoardTasks', 'someday', ['B', 'A'], 'B']]);
        expect(someday()).toEqual(['B', 'A']);
    });

    it('answers a request with nothing to write without saving or keeping a receipt', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const { host, recorder } = await openHost(saveData);
        const move = { type: 'moveCard' as const, taskId: 'n-rent', status: 'waiting' as const };
        const requestId = generateUUID();
        value(await host.runBoardAction({ requestId, action: move }));
        // Saves fail from here on; a finished move replayed after a restart still answers.
        saveData.mockRejectedValue(new Error('disk unavailable'));
        const saves = saveData.mock.calls.length;
        const restarted = createNativeHostContract();
        expect(await restarted.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        expect(await restarted.runBoardAction({ requestId, action: move })).toEqual({ ok: true, value: { changed: false, open: null } });
        const noOp = generateUUID();
        expect(await host.runBoardAction({ requestId: noOp, action: { type: 'trashTask', taskId: 't-trashed' } })).toEqual({ ok: true, value: { changed: false, open: null } });
        expect(saveData).toHaveBeenCalledTimes(saves);
        // No receipt was kept: the same ID can carry another action.
        saveData.mockResolvedValue(undefined);
        expect(value(await host.runBoardAction({ requestId: noOp, action: { type: 'trashTask', taskId: 'n-bulbs' } }))).toEqual({ changed: true, open: null });
        expect(recorder.log).toEqual([['updateTask', 'n-rent', { status: 'waiting' }], ['deleteTask', 'n-bulbs']]);
    });

    it('refuses invalid input', async () => {
        freezeClock();
        const { host } = await openHost();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        expect(host.getBoardView({ limit: 101 })).toMatchObject(invalid);
        expect(host.getBoardView({ filters: { tokens: '@home' } as never, limit: 1 })).toMatchObject(invalid);
        expect(host.getBoardView({ filters: { color: 'red' } as never, limit: 1 })).toMatchObject(invalid);
        expect(host.getBoardView({ filterEdit: { type: 'explode' } as never, limit: 1 })).toMatchObject(invalid);
        expect(host.getBoardList({ list: 'cards', offset: 0, limit: 10, revision: 'r' })).toMatchObject(invalid);
        const run = (action: unknown) => host.runBoardAction({ requestId: generateUUID(), action: action as never });
        expect(await host.runBoardAction({ requestId: 'not-a-uuid', action: { type: 'trashTask', taskId: 'n-rent' } })).toMatchObject(invalid);
        expect(await run({ type: 'moveCard', taskId: 'n-rent', status: 'reference' })).toMatchObject(invalid);
        // A drop into another column has no position; a drop inside names a card shown there.
        expect(await run({ type: 'moveCard', taskId: 'n-rent', status: 'waiting', afterId: 'w-alice' })).toMatchObject(invalid);
        expect(await run({ type: 'moveCard', taskId: 'n-rent', status: 'next', afterId: 'w-alice' })).toMatchObject(invalid);
        expect(await run({ type: 'moveCard', taskId: 'n-rent', status: 'next', afterId: 'n-demo', filters: { searchQuery: 'demo' } })).toMatchObject(invalid);
        expect(await run({ type: 'moveCard', taskId: 'r-manual', status: 'next' })).toMatchObject(invalid);
        expect(await run({ type: 'moveCard', taskId: 'missing', status: 'next' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'duplicateTask', taskId: 't-trashed' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(await run({ type: 'archiveColumn', status: 'done' })).toMatchObject(invalid);
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        expect(host.getBoardView({ limit: 10 })).toMatchObject(notReady);
        expect(host.getBoardList({ list: 'tokens', offset: 0, limit: 10, revision: 'r' })).toMatchObject(notReady);
        expect(await host.runBoardAction({ requestId: generateUUID(), action: { type: 'trashTask', taskId: 'n-rent' } })).toMatchObject(notReady);
    });
});
