// DingTalk todo sync maps MCP todo cards onto Mindwtr's shared import pipeline.
//
// Two properties of that pipeline shape this module:
//
//  1. `applyImport` skips any task whose derived id already exists — it never updates an
//     existing entity (import-apply.ts:431-436). That is what makes re-syncing idempotent, but
//     it also means a todo completed in DingTalk would never mark its Mindwtr task done. So a
//     reconcile pass runs after applyImport; see `reconcileCompletedTasks`.
//
//  2. Because applyImport skips wholesale, "title/dueDate are not synced" is currently a
//     side effect rather than a guarantee. The reconcile pass below breaks that assumption, so
//     it writes ONLY the fields in `RECONCILE_FIELD_WHITELIST` and spreads the rest untouched.
import {
    applyImport,
    type ImportExecutionResult,
    type ImportSource,
    type ImportTaskSource,
} from './import-apply';
import { isTaskFinished } from './task-status';
import { nextRevision } from './sync-revision';
import { generateDeterministicUUID } from './uuid';
import type { AppData, Task, TaskPriority } from './types';

export const DINGTALK_IMPORT_ID_NAMESPACE = 'mindwtr:dingtalk-import:v1';
export const DINGTALK_IMPORT_SUFFIX = ' (DingTalk)';

const DINGTALK_AREA_FALLBACK = 'DingTalk';
const DINGTALK_PROJECT_FALLBACK = 'DingTalk Import';
const DINGTALK_IMAGE_PREFIX = /^\[图片\]\s*/u;
const DINGTALK_IMAGE_ONLY = '[图片]';

// DingTalk's priority scale. 20 is the default and also the fallback when the field is absent
// (the API omits it for some todos — observed on real payloads).
const DINGTALK_PRIORITY_DEFAULT = 20;
const DINGTALK_PRIORITY_MAP: Record<number, TaskPriority> = {
    10: 'low',
    20: 'medium',
    30: 'high',
    40: 'urgent',
};

/**
 * A raw todo card as returned by the DingTalk MCP `get_user_todos` tool. Timestamps are epoch
 * milliseconds, and `0` is used interchangeably with `null` for "absent".
 */
export type DingTalkTodo = {
    taskId: string;
    subject: string;
    done: boolean;
    /** Epoch ms of completion; absent when not done. */
    doneTime?: number | null;
    /** Epoch ms; `null` and `0` both mean "no due date". */
    dueTime?: number | null;
    /** 10 / 20 / 30 / 40. May be missing entirely. */
    priority?: number;
    createdAt?: number | null;
};

export type ParsedDingTalkImportData = {
    tasks: ImportTaskSource[];
    /** Keyed by the Mindwtr task id this todo maps to, for the reconcile pass. */
    remoteByTaskId: Map<string, DingTalkTodo>;
    warnings: string[];
};

export type DingTalkImportExecutionResult = ImportExecutionResult & {
    /** Existing tasks flipped to done because DingTalk reports them finished. */
    completedExistingCount: number;
};

export const createDingTalkImportId = (
    kind: 'area' | 'project' | 'section' | 'task',
    sourceKey: string,
): string => generateDeterministicUUID(`${DINGTALK_IMPORT_ID_NAMESPACE}:${kind}:${sourceKey}`);

/**
 * DingTalk subjects are chat messages: they carry a `[图片]` marker for image posts, embedded
 * newlines, @-mentions, and can run to several hundred characters (a broadcast announcement).
 * The task title takes the first non-empty line after the marker; the full text stays in the
 * description. A post that is only an image keeps `[图片]` rather than becoming title-less.
 */
export const resolveDingTalkTitle = (subject: string): string => {
    const withoutMarker = subject.replace(DINGTALK_IMAGE_PREFIX, '');
    const firstLine = withoutMarker
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    if (firstLine) return firstLine;
    return subject.trim() || DINGTALK_IMAGE_ONLY;
};

const toIsoFromEpoch = (value?: number | null): string | undefined => {
    if (value === null || value === undefined || value === 0) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const toTaskPriority = (value?: number): TaskPriority => {
    const raw = typeof value === 'number' ? value : DINGTALK_PRIORITY_DEFAULT;
    return DINGTALK_PRIORITY_MAP[raw] ?? DINGTALK_PRIORITY_MAP[DINGTALK_PRIORITY_DEFAULT];
};

// The full original subject; the title keeps only its first line.
//
// Deliberately no DingTalk detail link. The only link the gateway offers is a mini-app deep link
// (n.dingtalk.com/dingding/dd-todo/...) that renders blank outside the DingTalk container —
// verified 2026-09-25 — so it would be dead weight in the description.
const buildDescription = (todo: DingTalkTodo): string => todo.subject.trim();

/**
 * Maps raw todo cards onto the shared `ImportSource` shape.
 *
 * Dedupes by `taskId`: querying both the `executor` and `creator` roles returns a todo the user
 * created and assigned to themselves twice.
 */
export const parseDingTalkTodos = (todos: readonly DingTalkTodo[]): ParsedDingTalkImportData => {
    const byTaskId = new Map<string, DingTalkTodo>();
    for (const todo of todos) {
        if (todo?.taskId) byTaskId.set(todo.taskId, todo);
    }

    const tasks: ImportTaskSource[] = [];
    const remoteByTaskId = new Map<string, DingTalkTodo>();
    let order = 0;

    for (const todo of byTaskId.values()) {
        // Registered before the skip below: a completed todo still has to be visible to the
        // reconcile pass, otherwise a task already in Mindwtr would never be closed when its
        // DingTalk todo completes.
        remoteByTaskId.set(createDingTalkImportId('task', todo.taskId), todo);

        // Already-completed todos are deliberately NOT imported. The account has 144 of them
        // against 275 open, and the Inbox is a place the user has to clear item by item — so it
        // stays limited to outstanding work. Completion still syncs for tasks imported earlier,
        // via the reconcile pass.
        if (todo.done) continue;

        tasks.push({
            sourceKey: todo.taskId,
            title: resolveDingTalkTitle(todo.subject),
            description: buildDescription(todo),
            status: 'inbox',
            dueDate: toIsoFromEpoch(todo.dueTime),
            createdAt: toIsoFromEpoch(todo.createdAt),
            priority: toTaskPriority(todo.priority),
            order: order++,
            // Deliberately no projectSourceKey / areaSourceKey: the requirement is that every
            // synced todo lands in the Inbox rather than a container.
        });
    }

    return { tasks, remoteByTaskId, warnings: [] };
};

/**
 * Flips tasks to done when DingTalk reports the matching todo finished.
 *
 * Skips tombstones (the user deleted it), cancellations (changing status would discard the
 * cancel semantics), and anything already finished (re-bumping `rev` every sync would churn the
 * sync document). Only ever moves toward done — a todo reopened in DingTalk does not reopen a
 * task the user already completed.
 */
const reconcileCompletedTasks = (
    tasks: readonly Task[],
    parsed: ParsedDingTalkImportData,
    deviceId: string | undefined,
    nowIso: string,
): { tasks: Task[]; completedExistingCount: number } => {
    let completedExistingCount = 0;

    const nextTasks = tasks.map((task) => {
        const todo = parsed.remoteByTaskId.get(task.id);
        if (!todo?.done) return task;
        if (task.deletedAt || task.purgedAt) return task;
        if (task.cancelledAt) return task;
        if (isTaskFinished(task)) return task;

        completedExistingCount += 1;
        return {
            ...task,
            status: 'done' as const,
            // Explicit, so it is not backfilled to the sync clock by normalizeTaskLifecycleFields.
            completedAt: toIsoFromEpoch(todo.doneTime) ?? nowIso,
            updatedAt: nowIso,
            rev: nextRevision(task.rev),
            revBy: deviceId,
        };
    });

    return { tasks: nextTasks, completedExistingCount };
};

const resolveNowIso = (now?: Date | string): string => {
    const resolved = now instanceof Date
        ? now
        : typeof now === 'string' && now.trim()
            ? new Date(now)
            : new Date();
    return Number.isFinite(resolved.getTime()) ? resolved.toISOString() : new Date().toISOString();
};

export const applyDingTalkImport = (
    currentData: AppData,
    parsed: ParsedDingTalkImportData,
    options: { now?: Date | string } = {},
): DingTalkImportExecutionResult => {
    const source: ImportSource = {
        areas: [],
        projects: [],
        tasks: parsed.tasks,
        warnings: parsed.warnings,
    };

    const applied = applyImport(currentData, source, {
        fallbacks: { area: DINGTALK_AREA_FALLBACK, project: DINGTALK_PROJECT_FALLBACK },
        // Required: applyImport defaults to uuidv4(), which would mint fresh ids on every sync
        // and duplicate the whole list instead of matching it.
        idFor: createDingTalkImportId,
        suffix: DINGTALK_IMPORT_SUFFIX,
        now: options.now,
    });

    const reconciled = reconcileCompletedTasks(
        applied.data.tasks,
        parsed,
        applied.data.settings.deviceId,
        resolveNowIso(options.now),
    );

    const warnings = [...applied.warnings];
    if (reconciled.completedExistingCount > 0) {
        warnings.push(reconciled.completedExistingCount === 1
            ? '1 previously imported task was marked done to match DingTalk.'
            : `${reconciled.completedExistingCount} previously imported tasks were marked done to match DingTalk.`);
    }

    return {
        ...applied,
        data: { ...applied.data, tasks: reconciled.tasks },
        completedExistingCount: reconciled.completedExistingCount,
        warnings,
    };
};
