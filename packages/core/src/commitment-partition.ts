/**
 * Splits a task list into the three commitment bands.
 *
 * The bands are physical partitions, not comparator weights. A pinned task
 * must not also appear in the P-ordered band, so `pinned` is cut out before
 * `rated` is built — the same mutual-exclusion pattern focus-sections.ts uses
 * for Today's Focus, where a focused task is filtered out of every other band.
 *
 * `unrated` keeps the order it was handed. That is the point of the band: a
 * task nobody has assessed must not be silently reordered by a score it does
 * not have. Do not route this through sortTasksBySavedPreference — its byId()
 * fallback reorders ties (task-utils.ts), which would shuffle exactly the
 * tasks this band exists to leave alone.
 */

import type { CommitmentBenchmark, CommitmentCard } from './commitment-types';
import { computeCommitmentScore, hasHardConstraint, type CommitmentScore } from './commitment-score';
import type { Task } from './types';

export interface CommitmentPartition {
    /** Hard-constraint tasks, in the order they were handed over. */
    pinned: Task[];
    /** Scored tasks, highest P first. */
    rated: Task[];
    /** No card, or a card that cannot be scored — incoming order preserved. */
    unrated: Task[];
    /** taskId → score, so callers rendering a badge need not recompute. */
    scores: Record<string, CommitmentScore>;
}

/**
 * @param defaultOrdered tasks already in their default order. Both `pinned`
 *   and `unrated` inherit this order; only `rated` is re-sorted.
 */
export function partitionByCommitment(
    defaultOrdered: readonly Task[],
    cards: Record<string, CommitmentCard>,
    benchmarks: readonly CommitmentBenchmark[],
    now: Date,
): CommitmentPartition {
    const benchmarkById = new Map(benchmarks.map((benchmark) => [benchmark.id, benchmark]));

    const pinned: Task[] = [];
    const scored: Array<{ task: Task; score: CommitmentScore }> = [];
    const unrated: Task[] = [];

    for (const task of defaultOrdered) {
        const card = cards[task.id];
        if (!card) {
            unrated.push(task);
            continue;
        }
        if (hasHardConstraint(card)) {
            pinned.push(task);
            continue;
        }

        const score = computeCommitmentScore(
            task,
            card,
            benchmarkById.get(card.benchmarkId),
            now,
        );
        if (!score) {
            // A card whose benchmark is gone ranks nowhere rather than first.
            unrated.push(task);
            continue;
        }
        scored.push({ task, score });
    }

    // Array.prototype.sort is stable, so equal P values keep the incoming
    // order — the tie-break is "whatever default order said", not task id.
    scored.sort((a, b) => b.score.p - a.score.p);

    const scores: Record<string, CommitmentScore> = {};
    for (const { task, score } of scored) scores[task.id] = score;

    return { pinned, rated: scored.map((entry) => entry.task), unrated, scores };
}
