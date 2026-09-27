/**
 * The P-value: which of these do I do first.
 *
 *   P          = value ÷ complexity
 *   value      = goal + urgency + impact + delegable
 *   goal       = max(goalPerf, goalCap)
 *   urgency    = derived from dueDate
 *   complexity = benchmark.points × multiplier
 *
 * Urgency is derived rather than asked for. "Due within 48h / this week / no
 * deadline" is a restatement of the due date, and asking for it separately
 * invites the two answers to disagree.
 *
 * The numerator and denominator deliberately pull in opposite directions: the
 * numerator asks how much the task is worth, the denominator what it costs.
 * A high P means worth doing and cheap to do.
 */

import type { CommitmentBenchmark, CommitmentCard } from './commitment-types';
import { safeParseDueDate } from './date';
import type { Task } from './types';

const HOURS_WITHIN_48 = 48;
const HOURS_WITHIN_WEEK = 168;

export type UrgencyReason = 'within-48h' | 'this-week' | 'no-deadline';

export interface CommitmentUrgency {
    value: number;
    reason: UrgencyReason;
}

export interface CommitmentScore {
    /** max(goalPerf, goalCap) — the stronger of the two long-term goals. */
    goal: number;
    urgency: number;
    impact: number;
    delegable: number;
    /** goal + urgency + impact + delegable. */
    value: number;
    benchmarkPoints: number;
    multiplier: number;
    /** benchmarkPoints × multiplier. Always > 0 on a returned score. */
    complexity: number;
    p: number;
    urgencyReason: UrgencyReason;
}

/**
 * Urgency from the due date: inside 48h is 3, inside the week is 2, anything
 * else (including no date) is 1. A date already past falls into the first
 * bucket, which is what makes an overdue task climb.
 */
export function deriveUrgency(dueDate: string | undefined, now: Date): CommitmentUrgency {
    const due = safeParseDueDate(dueDate);
    if (!due) return { value: 1, reason: 'no-deadline' };

    const hours = (due.getTime() - now.getTime()) / 3_600_000;
    if (hours <= HOURS_WITHIN_48) return { value: 3, reason: 'within-48h' };
    if (hours <= HOURS_WITHIN_WEEK) return { value: 2, reason: 'this-week' };
    return { value: 1, reason: 'no-deadline' };
}

/**
 * Null means "not scoreable, keep it out of the ordering" — a card pointing at
 * a benchmark that has since been deleted, or one whose points are zero. Both
 * would otherwise divide by zero or produce Infinity, and a task with no
 * meaningful cost is better left unranked than ranked first.
 */
export function computeCommitmentScore(
    task: Pick<Task, 'dueDate'>,
    card: CommitmentCard,
    benchmark: CommitmentBenchmark | undefined,
    now: Date,
): CommitmentScore | null {
    const points = benchmark?.points;
    if (typeof points !== 'number' || !Number.isFinite(points) || points <= 0) return null;

    const complexity = points * card.multiplier;
    if (!Number.isFinite(complexity) || complexity <= 0) return null;

    const goal = Math.max(card.goalPerf, card.goalCap);
    const { value: urgency, reason: urgencyReason } = deriveUrgency(task.dueDate, now);
    const value = goal + urgency + card.impact + card.delegable;

    return {
        goal,
        urgency,
        impact: card.impact,
        delegable: card.delegable,
        value,
        benchmarkPoints: points,
        multiplier: card.multiplier,
        complexity,
        p: value / complexity,
        urgencyReason,
    };
}

/** True when the card pins the task above the P-value ordering. */
export function hasHardConstraint(card: CommitmentCard | undefined): boolean {
    return (card?.hardConstraints.length ?? 0) > 0;
}
