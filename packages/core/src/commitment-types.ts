/**
 * Commitment-management types.
 *
 * A commitment card is an optional assessment layered on a Task, not a field
 * of it. Keeping it out of `Task` is deliberate: a new Task field has to clear
 * the sync-schema parity check, the SQLite column list, and the CloudKit
 * release gate (task-sync-schema.ts) — far more surface than this feature
 * needs. Cards live in their own table keyed by task id instead, and never
 * enter the sync pipeline.
 *
 * Scores are derived on read from the card plus the task's own fields; only
 * the inputs below are persisted.
 */

/** How much the task moves a long-term goal: 直接 / 支持 / 无关. */
export type GoalLevel = 3 | 2 | 1;

/** How much the outcome is felt outside your own work: 重大 / 一般 / 轻微. */
export type ImpactLevel = 3 | 2 | 1;

/** Whether it has to be you: 必须我 / 可部分委托 / 可完全委托. */
export type DelegableLevel = 3 | 2 | 1;

/** How this run compares to its benchmark: 简单 / 差不多 / 复杂. */
export type ComplexityMultiplier = 0.5 | 1 | 2;

/** Which of the four delivery bars this run is aiming at. */
export type TargetTier = 'pass' | 'good' | 'excellent';

/**
 * Non-negotiables. A card carrying any of these is pinned above the P-value
 * ordering instead of competing in it — arithmetic cannot express "this one
 * does not get traded away".
 */
export type HardConstraint =
    | 'health'
    | 'family'
    | 'compliance'
    | 'external-deadline'
    | 'critical-path';

export type MilestoneStatus = 'todo' | 'doing' | 'done' | 'delayed' | 'blocked';

/**
 * A stage node on the way to delivery. Stored inside the card's JSON rather
 * than on `Task.checklist`: that type is fixed at exactly three keys, the read
 * path silently drops anything else (task-sync-schema.ts toChecklist), and the
 * Rust local API rejects a fourth key outright (local_api.rs valid_checklist).
 */
export interface CommitmentMilestone {
    id: string;
    title: string;
    targetDate?: string;
    status: MilestoneStatus;
    /** 0–100. */
    progress: number;
    actualHours?: number;
}

export interface CommitmentCard {
    goalPerf: GoalLevel;
    goalCap: GoalLevel;
    impact: ImpactLevel;
    delegable: DelegableLevel;
    hardConstraints: HardConstraint[];
    /**
     * Marks the deadline as non-negotiable. Lives here rather than on
     * `Task.dueDate`, which upstream treats as a *soft* date — it counts how
     * often the date was pushed (task-utils.ts, `pushCount`).
     */
    isHardDeadline: boolean;
    benchmarkId: string;
    multiplier: ComplexityMultiplier;
    targetTier: TargetTier;
    milestones: CommitmentMilestone[];
    /** The one-line justification as it read when the card was last saved. */
    reasonSnapshot?: string;
}

/**
 * An anchor task: "this is about as big as N sign-up flows". `points` is the
 * divisor in the P-value; p50/p80 are the personal baselines that make the
 * estimate a comparison rather than a guess.
 */
export interface CommitmentBenchmark {
    id: string;
    name: string;
    points: number;
    p50?: string;
    p80?: string;
    /** What "done" looks like for this kind of task. */
    dod?: string;
    orderNum?: number;
}

/**
 * Seed anchors, written on first open when the table is empty. Names are plain
 * data rather than i18n keys: a benchmark is renamed by the user, and a stored
 * name must not change when the UI language does.
 */
export const DEFAULT_BENCHMARKS: readonly CommitmentBenchmark[] = [
    { id: 'weekly-report', name: 'Weekly report', points: 1, p50: '0.5h', p80: '1h', dod: 'Sent on time, no errors', orderNum: 1 },
    { id: 'deck-10p', name: '10-page review deck', points: 2, p50: '3h', p80: '5h', dod: 'Numbers correct, conclusion clear', orderNum: 2 },
    { id: 'auth-flow', name: 'Sign-up / login flow', points: 3, p50: '1d', p80: '2d', dod: 'Happy path works, no blocking bugs', orderNum: 3 },
    { id: 'client-draft', name: 'Client proposal draft', points: 3, p50: '4h', p80: '8h', dod: 'Covers the ask, ready to review', orderNum: 4 },
    { id: 'q3-review', name: 'Quarterly review', points: 5, p50: '6h', p80: '10h', dod: 'Approved first pass', orderNum: 5 },
    { id: 'small-migration', name: 'Small data migration', points: 8, p50: '2d', p80: '4d', dod: 'Data consistent, reversible', orderNum: 6 },
];

const GOAL_LEVELS: readonly GoalLevel[] = [3, 2, 1];
const MULTIPLIERS: readonly ComplexityMultiplier[] = [0.5, 1, 2];
const TIERS: readonly TargetTier[] = ['pass', 'good', 'excellent'];
const HARD_CONSTRAINTS: readonly HardConstraint[] = [
    'health',
    'family',
    'compliance',
    'external-deadline',
    'critical-path',
];
const MILESTONE_STATUSES: readonly MilestoneStatus[] = ['todo', 'doing', 'done', 'delayed', 'blocked'];

const oneOf = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Coerces a card read back from disk into a usable one.
 *
 * The card is stored as JSON, so a hand-edited or half-written row can carry
 * anything. A missing `impact` would otherwise reach the score as `undefined`
 * and turn the whole P-value into NaN, which sorts unpredictably — a wrong
 * number is worse here than a missing field.
 */
export function normalizeCommitmentCard(value: unknown): CommitmentCard | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;

    const milestones = asArray(raw.milestones).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        const id = asString(item.id);
        const title = asString(item.title);
        if (!id || !title) return [];
        return [{
            id,
            title,
            targetDate: asString(item.targetDate),
            status: oneOf(MILESTONE_STATUSES, item.status, 'todo'),
            progress: Math.min(100, Math.max(0, asNumber(item.progress) ?? 0)),
            actualHours: asNumber(item.actualHours),
        }];
    });

    return {
        goalPerf: oneOf(GOAL_LEVELS, raw.goalPerf, 1),
        goalCap: oneOf(GOAL_LEVELS, raw.goalCap, 1),
        impact: oneOf(GOAL_LEVELS, raw.impact, 1),
        delegable: oneOf(GOAL_LEVELS, raw.delegable, 1),
        hardConstraints: asArray(raw.hardConstraints)
            .filter((entry): entry is HardConstraint => HARD_CONSTRAINTS.includes(entry as HardConstraint)),
        isHardDeadline: raw.isHardDeadline === true,
        benchmarkId: asString(raw.benchmarkId) ?? '',
        multiplier: oneOf(MULTIPLIERS, raw.multiplier, 1),
        targetTier: oneOf(TIERS, raw.targetTier, 'pass'),
        milestones,
        reasonSnapshot: asString(raw.reasonSnapshot),
    };
}

/** Same coercion for a benchmark row. `points` must stay positive to be usable. */
export function normalizeCommitmentBenchmark(value: unknown): CommitmentBenchmark | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;

    const id = asString(raw.id);
    const name = asString(raw.name);
    const points = asNumber(raw.points);
    if (!id || !name || points === undefined || points <= 0) return null;

    return {
        id,
        name,
        points,
        p50: asString(raw.p50),
        p80: asString(raw.p80),
        dod: asString(raw.dod),
        orderNum: asNumber(raw.orderNum),
    };
}

