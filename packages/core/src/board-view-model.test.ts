import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    applyBoardFilterEdit,
    BOARD_CARD_SWIPES,
    EMPTY_BOARD_FILTER_STATE,
    getBoardCard,
    getBoardFilterSummary,
    planBoardDrop,
    toggleBoardDuePreset,
} from './board-view-model';
import { createBoardRecorder, loadBoardViewsFixture, replayBoardScenario, seedBoardStore } from './board-view-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { resetForTests } from './store';
import type { Task } from './types';

const fixture = loadBoardViewsFixture();

describe('Board parity with the frozen React Native fixture', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.board.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.board.now));
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('was captured from React Native before the screen changed', () => {
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.board.scenarios.length).toBe(Object.keys(fixture.board.observations).length);
    });

    for (const scenario of fixture.board.scenarios) {
        it(`the native host contract reproduces "${scenario.name}"`, async () => {
            const recorder = createBoardRecorder();
            await seedBoardStore(fixture.board, scenario, recorder);
            const contract = createNativeHostContract();
            expect((await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).ok).toBe(true);
            expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
            recorder.log.splice(0);
            const observed = await replayBoardScenario({ scenario, recorder, contract });
            expect(observed).toEqual(fixture.board.observations[scenario.name]);
        });
    }
});

describe('Board view model', () => {
    const t = (key: string) => ({
        'filters.label': 'Filters', 'common.search': 'Search', 'search.due.label': 'Due date', 'filters.datePreset.overdue': 'Overdue',
    }[key] ?? key);

    it('runs only the action on the opened swipe side', () => {
        expect(BOARD_CARD_SWIPES.left.actions).toEqual(['duplicate']);
        expect(BOARD_CARD_SWIPES.right.actions).toEqual(['trash']);
    });

    it('toggles a due-date preset: sets it, replaces another, clears itself', () => {
        expect(toggleBoardDuePreset({}, 'overdue')).toEqual({ dueDateRange: { preset: 'overdue' } });
        expect(toggleBoardDuePreset({ dueDateRange: { preset: 'today' } }, 'overdue')).toEqual({ dueDateRange: { preset: 'overdue' } });
        expect(toggleBoardDuePreset({ dueDateRange: { preset: 'overdue' } }, 'overdue')).toEqual({});
    });

    it('counts every criterion, the due date and the search on the Filters button', () => {
        const summary = getBoardFilterSummary({
            criteria: { contexts: ['@a', '@b'], tags: ['#x'], projects: ['p1', 'p2'], excludedTags: ['#later'], dueDateRange: { preset: 'overdue' } },
            searchQuery: ' rent ',
            t,
        });
        expect(summary).toMatchObject({ activeCount: 8, filterLabel: 'Filters (8)', active: true, duePreset: 'overdue' });
        expect(summary.chips).toEqual([{ id: 'board-search', label: 'Search: rent' }, { id: 'board-due-date', label: 'Due date: Overdue' }]);
        expect(getBoardFilterSummary({ criteria: {}, searchQuery: '  ', t })).toMatchObject({ activeCount: 0, filterLabel: 'Filters', active: false });
    });

    it('plans a drop: a status change across columns, a reorder inside one, nothing when the card is already there', () => {
        const task = { id: 'b', status: 'next' as const };
        const columnIds = ['a', 'b', 'c'];
        expect(planBoardDrop({ task, status: 'waiting', columnIds: [] })).toEqual({ kind: 'status', taskId: 'b', status: 'waiting' });
        expect(planBoardDrop({ task, status: 'next', columnIds, afterId: null })).toEqual({ kind: 'reorder', status: 'next', orderedIds: ['b', 'a', 'c'], taskId: 'b' });
        expect(planBoardDrop({ task, status: 'next', columnIds, afterId: 'c' })).toEqual({ kind: 'reorder', status: 'next', orderedIds: ['a', 'c', 'b'], taskId: 'b' });
        expect(planBoardDrop({ task, status: 'next', columnIds, afterId: 'a' })).toBeNull();
        expect(planBoardDrop({ task, status: 'next', columnIds })).toBeNull();
        expect(planBoardDrop({ task, status: 'next', columnIds, afterId: 'missing' })).toBeNull();
        expect(planBoardDrop({ task: { id: 'r', status: 'reference' }, status: 'next', columnIds })).toBeNull();
    });

    it('shows a project badge in its area color, never the project placeholder', () => {
        const badges = new Map([['p', { title: 'Launch', color: '#2563eb' }], ['q', { title: 'Loose' }]]);
        const task = { id: 't', title: 'T', status: 'next', projectId: 'p', tags: [], contexts: [], createdAt: '', updatedAt: '' } as Task;
        expect(getBoardCard(task, { badges, timeEstimatesEnabled: true, t })).toMatchObject({ projectTitle: 'Launch', projectColor: '#2563eb', showMetaRow: true });
        expect(getBoardCard({ ...task, projectId: 'q' }, { badges, timeEstimatesEnabled: true, t })).toMatchObject({ projectTitle: 'Loose', projectColor: null });
        expect(getBoardCard({ ...task, projectId: undefined, timeEstimate: '2hr' }, { badges, timeEstimatesEnabled: false, t }).showMetaRow).toBe(false);
    });

    it('formats preset and custom time estimates with the Board language', () => {
        const task = { id: 't', title: 'T', status: 'next', tags: [], contexts: [], createdAt: '', updatedAt: '' } as Task;
        const units = (key: string) => ({
            'units.minutesShort': '{minutes} min.',
            'units.hoursShort': '{hours} h.',
            'units.hoursMinutesShort': '{hours} h. {minutes} min.',
        }[key] ?? key);
        const options = { badges: new Map(), timeEstimatesEnabled: true, t: units };
        expect(getBoardCard({ ...task, timeEstimate: '30min' }, options).timeEstimateLabel).toBe('30 min.');
        expect(getBoardCard({ ...task, timeEstimate: 'custom:45' }, options).timeEstimateLabel).toBe('45 min.');
    });

    it('keeps match modes on any until a second token of the kind is picked, and Clear empties everything', () => {
        let state = applyBoardFilterEdit(EMPTY_BOARD_FILTER_STATE, { type: 'setMatchMode', kind: 'context', value: 'all' });
        expect(state.contextMatchMode).toBe('any');
        state = applyBoardFilterEdit(state, { type: 'toggleToken', value: '@a' });
        state = applyBoardFilterEdit(state, { type: 'setMatchMode', kind: 'context', value: 'all' });
        expect(state).toMatchObject({ tokens: ['@a'], contextMatchMode: 'all' });
        state = applyBoardFilterEdit(state, { type: 'toggleToken', value: '@a' });
        expect(state).toMatchObject({ tokens: [], excludedTokens: ['@a'], contextMatchMode: 'any' });
        state = applyBoardFilterEdit({ ...state, searchQuery: 'x', duePreset: 'today' }, { type: 'clear' });
        expect(state).toEqual(EMPTY_BOARD_FILTER_STATE);
    });
});
