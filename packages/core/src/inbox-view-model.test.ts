import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAreaFilterSelection } from './area-filter';
import { loadTranslations } from './i18n/i18n-loader';
import { replayInboxScenario, loadInboxViewFixture, seedInboxStore } from './inbox-view-model.replay';
import { buildInboxScreenModel, buildStatusListModel, selectStatusListTasks } from './menu-views-model';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppSettings } from './types';

const fixture = loadInboxViewFixture();

describe('Inbox view model: React Native parity', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
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
    });

    it('replays every frozen React Native Inbox scenario through core\'s models', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        for (const scenario of fixture.scenarios) {
            const writes: unknown[] = [];
            await seedInboxStore(fixture, scenario, writes);
            writes.length = 0;
            const observations = await replayInboxScenario({ scenario, writes, t });
            expect({ [scenario.name]: observations }).toEqual({ [scenario.name]: fixture.observations[scenario.name] });
        }
    });

    it('caps the Process label at 99+ while its spoken label keeps the count, and promotes Mind Sweep when empty', () => {
        const label = (count: number) => buildInboxScreenModel({ count, settings: {}, t });
        expect(label(0)).toMatchObject({ process: null, mindSweep: { placement: 'primary' } });
        expect(label(1).process).toEqual({ label: 'Process Inbox (1)', accessibilityLabel: 'Process Inbox (1)', count: 1 });
        expect(label(99).process?.label).toBe('Process Inbox (99)');
        expect(label(100).process).toMatchObject({ label: 'Process Inbox (99+)', accessibilityLabel: 'Process Inbox (100)' });
        expect(label(100).mindSweep.placement).toBe('accessory');
    });

    it('drops Time estimate from the sort sheet while that feature is off, and reads a stored time sort as default', async () => {
        const writes: unknown[] = [];
        await seedInboxStore(fixture, { settings: 'base' }, writes);
        const settings: AppSettings = { taskSortBy: 'timeEstimate', features: { timeEstimates: false } };
        const state = useTaskStore.getState();
        const tasks = selectStatusListTasks({
            kind: 'inbox', tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, state.areas), areaById: new Map(),
        });
        const model = buildStatusListModel({
            kind: 'inbox', tasks, projects: state.projects, areas: state.areas, settings,
            groupBy: 'none', criteria: {}, searchQuery: '', collapsedGroupIds: new Set(), t,
        });
        expect(model.sortBy).toBe('default');
        expect(model.sortOptions.map((option) => option.value)).not.toContain('timeEstimate');
        expect(model.sortOptions.find((option) => option.selected)?.value).toBe('default');
    });
});
