import { describe, expect, it } from 'vitest';

import {
    applyDingTalkImport,
    createDingTalkImportId,
    parseDingTalkTodos,
    resolveDingTalkTitle,
    type DingTalkTodo,
} from './dingtalk-import';
import { mockAppData } from './sync-test-utils';
import type { Task } from './types';

const DUE_MS = 1_790_157_600_000;      // 2026-09-23T10:00:00Z
const DONE_MS = 1_790_200_000_000;
const CREATED_MS = 1_790_149_368_000;

const todo = (overrides: Partial<DingTalkTodo> = {}): DingTalkTodo => ({
    taskId: '57501590769',
    subject: '跟林丛对接下',
    done: false,
    dueTime: DUE_MS,
    createdAt: CREATED_MS,
    priority: 20,
    ...overrides,
});

const taskIdOf = (sourceTaskId: string): string => createDingTalkImportId('task', sourceTaskId);

describe('resolveDingTalkTitle', () => {
    it('strips the [图片] prefix and keeps the first non-empty line', () => {
        expect(resolveDingTalkTitle('[图片]\n同事，融通系统查不到数据')).toBe('同事，融通系统查不到数据');
    });

    it('keeps [图片] itself when nothing else remains', () => {
        expect(resolveDingTalkTitle('[图片]')).toBe('[图片]');
    });

    it('takes the first non-empty line of a long multi-line announcement', () => {
        expect(resolveDingTalkTitle('第一行标题\n第二行\n第三行')).toBe('第一行标题');
    });

    it('keeps @-mentions as-is', () => {
        expect(resolveDingTalkTitle('@林济煜 你跟林丛对接下')).toBe('@林济煜 你跟林丛对接下');
    });
});

describe('parseDingTalkTodos', () => {
    it('maps an unfinished todo into an inbox task', () => {
        const parsed = parseDingTalkTodos([todo()]);
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]).toMatchObject({
            sourceKey: '57501590769',
            title: '跟林丛对接下',
            status: 'inbox',
        });
    });

    it('does not import a todo that is already completed', () => {
        const parsed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        expect(parsed.tasks).toEqual([]);
    });

    it('still exposes a completed todo to the reconcile pass', () => {
        const parsed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        expect(parsed.remoteByTaskId.get(taskIdOf('57501590769'))?.done).toBe(true);
    });

    it('treats both null and 0 dueTime as no due date', () => {
        const parsed = parseDingTalkTodos([
            todo({ taskId: 'a', dueTime: null }),
            todo({ taskId: 'b', dueTime: 0 }),
        ]);
        expect(parsed.tasks.every((task) => task.dueDate === undefined)).toBe(true);
    });

    it('falls back to a default priority when the field is missing', () => {
        const parsed = parseDingTalkTodos([todo({ priority: undefined })]);
        expect(parsed.tasks[0].priority).toBeDefined();
    });

    it('maps DingTalk priorities onto Mindwtr priorities', () => {
        const parsed = parseDingTalkTodos([
            todo({ taskId: 'a', priority: 40 }),
            todo({ taskId: 'b', priority: 10 }),
        ]);
        expect(parsed.tasks[0].priority).not.toBe(parsed.tasks[1].priority);
    });

    it('dedupes the same taskId returned for both executor and creator roles', () => {
        const parsed = parseDingTalkTodos([todo(), todo()]);
        expect(parsed.tasks).toHaveLength(1);
    });

    it('keeps the full original subject in the description, with no link', () => {
        const parsed = parseDingTalkTodos([todo({ subject: '第一行\n第二行' })]);

        expect(parsed.tasks[0].description).toBe('第一行\n第二行');
        // The gateway's only link is a mini-app deep link that renders blank outside DingTalk.
        expect(parsed.tasks[0].description).not.toContain('http');
    });

    it('never assigns a project or area, so tasks land in the Inbox', () => {
        const parsed = parseDingTalkTodos([todo()]);
        expect(parsed.tasks[0].projectSourceKey).toBeUndefined();
        expect(parsed.tasks[0].areaSourceKey).toBeUndefined();
    });
});

describe('applyDingTalkImport', () => {
    it('creates standalone inbox tasks on first sync', () => {
        const parsed = parseDingTalkTodos([todo()]);
        const result = applyDingTalkImport(mockAppData(), parsed);

        expect(result.importedTaskCount).toBe(1);
        const created = result.data.tasks[0];
        expect(created.status).toBe('inbox');
        expect(created.projectId).toBeUndefined();
        expect(created.areaId).toBeUndefined();
        expect(created.id).toBe(taskIdOf('57501590769'));
    });

    it('is idempotent: a second sync creates nothing', () => {
        const parsed = parseDingTalkTodos([todo()]);
        const first = applyDingTalkImport(mockAppData(), parsed);
        const second = applyDingTalkImport(first.data, parsed);

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks.map((task) => task.id)).toEqual(first.data.tasks.map((task) => task.id));
    });

    it('marks an existing task done when DingTalk reports it finished', () => {
        const open = parseDingTalkTodos([todo()]);
        const first = applyDingTalkImport(mockAppData(), open);

        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport(first.data, closed);

        const task = second.data.tasks[0];
        expect(task.status).toBe('done');
        expect(second.completedExistingCount).toBe(1);
    });

    it('uses the DingTalk completion time, not the sync clock', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport(first.data, closed, { now: new Date('2030-01-01T00:00:00Z') });

        expect(second.data.tasks[0].completedAt).toBe(new Date(DONE_MS).toISOString());
    });

    it('bumps rev by exactly one and stamps revBy with the device id', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const before = first.data.tasks[0];

        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport(first.data, closed);
        const after = second.data.tasks[0];

        expect(after.rev).toBe((before.rev ?? 0) + 1);
        expect(after.revBy).toBe(second.data.settings.deviceId);
    });

    // The requirement says title/dueDate changes must NOT be synced. applyImport guarantees this
    // today only because it skips existing tasks wholesale; reconcile breaks that assumption, so
    // the field whitelist is the sole remaining guard. This is the regression test for it.
    it('never rewrites title or dueDate while reconciling completion', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const before = first.data.tasks[0];

        const renamed = parseDingTalkTodos([
            todo({ subject: '远端改过的标题', dueTime: DUE_MS + 86_400_000, done: true, doneTime: DONE_MS }),
        ]);
        const second = applyDingTalkImport(first.data, renamed);
        const after = second.data.tasks[0];

        expect(after.title).toBe(before.title);
        expect(after.dueDate).toBe(before.dueDate);
        expect(after.status).toBe('done');
    });

    it('does not touch a task the user deleted', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const deleted: Task[] = [{ ...first.data.tasks[0], deletedAt: '2026-09-23T00:00:00.000Z' }];
        const withTombstone = { ...first.data, tasks: deleted };

        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport(withTombstone, closed);

        expect(second.data.tasks[0].status).toBe('inbox');
        expect(second.completedExistingCount).toBe(0);
    });

    it('does not resurrect a deleted task', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const deleted: Task[] = [{ ...first.data.tasks[0], deletedAt: '2026-09-23T00:00:00.000Z' }];

        const second = applyDingTalkImport({ ...first.data, tasks: deleted }, parseDingTalkTodos([todo()]));
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0].deletedAt).toBeDefined();
    });

    it('does not flip a cancelled task to done', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const cancelled: Task[] = [{
            ...first.data.tasks[0],
            status: 'archived',
            cancelledAt: '2026-09-23T00:00:00.000Z',
        }];

        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport({ ...first.data, tasks: cancelled }, closed);

        expect(second.data.tasks[0].status).toBe('archived');
        expect(second.completedExistingCount).toBe(0);
    });

    it('does not re-bump rev for a task that is already finished', () => {
        const first = applyDingTalkImport(mockAppData(), parseDingTalkTodos([todo()]));
        const revAfterImport = first.data.tasks[0].rev;

        const closed = parseDingTalkTodos([todo({ done: true, doneTime: DONE_MS })]);
        const second = applyDingTalkImport(first.data, closed);
        const third = applyDingTalkImport(second.data, closed);

        expect(second.completedExistingCount).toBe(1);
        expect(second.data.tasks[0].rev).toBeGreaterThan(revAfterImport);
        // A third pass must be a no-op, or every sync would churn the sync document.
        expect(third.data.tasks[0].rev).toBe(second.data.tasks[0].rev);
        expect(third.completedExistingCount).toBe(0);
    });
});
