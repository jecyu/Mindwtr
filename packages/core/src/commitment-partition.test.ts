import { describe, expect, it } from 'vitest';
import type { CommitmentBenchmark, CommitmentCard } from './commitment-types';
import { partitionByCommitment } from './commitment-partition';
import type { Task } from './types';

const NOW = new Date(2026, 8, 27, 10, 0, 0);

const task = (id: string): Task => ({
    id,
    title: id,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

const card = (overrides: Partial<CommitmentCard> = {}): CommitmentCard => ({
    goalPerf: 1,
    goalCap: 1,
    impact: 1,
    delegable: 1,
    hardConstraints: [],
    isHardDeadline: false,
    benchmarkId: 'bench',
    multiplier: 1,
    targetTier: 'pass',
    milestones: [],
    ...overrides,
});

const BENCHMARKS: CommitmentBenchmark[] = [{ id: 'bench', name: 'Bench', points: 1 }];

const ids = (tasks: readonly Task[]) => tasks.map((entry) => entry.id);

describe('partitionByCommitment', () => {
    it('splits into pinned, rated and unrated', () => {
        const tasks = [task('a'), task('b'), task('c')];
        const { pinned, rated, unrated } = partitionByCommitment(
            tasks,
            {
                a: card({ hardConstraints: ['external-deadline'] }),
                b: card({ impact: 3 }),
                // c has no card
            },
            BENCHMARKS,
            NOW,
        );

        expect(ids(pinned)).toEqual(['a']);
        expect(ids(rated)).toEqual(['b']);
        expect(ids(unrated)).toEqual(['c']);
    });

    it('does not let a pinned task also appear in the rated band', () => {
        const tasks = [task('a'), task('b')];
        const { pinned, rated, scores } = partitionByCommitment(
            tasks,
            { a: card({ hardConstraints: ['health'], impact: 3 }), b: card() },
            BENCHMARKS,
            NOW,
        );

        expect(ids(pinned)).toEqual(['a']);
        expect(ids(rated)).toEqual(['b']);
        // Pinned tasks are excluded, not merely ranked first — and they carry
        // no score, because they never entered the comparison.
        expect(scores.a).toBeUndefined();
    });

    it('orders the rated band by descending P', () => {
        const tasks = [task('low'), task('high'), task('mid')];
        const { rated } = partitionByCommitment(
            tasks,
            {
                low: card({ impact: 1 }),
                high: card({ impact: 3, delegable: 3 }),
                mid: card({ impact: 2 }),
            },
            BENCHMARKS,
            NOW,
        );

        expect(ids(rated)).toEqual(['high', 'mid', 'low']);
    });

    it('keeps the incoming order for ties rather than falling back to id', () => {
        // Same score for both. The band must not reorder them — an unassessed
        // or equally-assessed task keeps whatever default order said.
        const tasks = [task('zebra'), task('apple')];
        const { rated } = partitionByCommitment(
            tasks,
            { zebra: card({ impact: 2 }), apple: card({ impact: 2 }) },
            BENCHMARKS,
            NOW,
        );

        expect(ids(rated)).toEqual(['zebra', 'apple']);
    });

    it('leaves unrated tasks in the exact order they arrived', () => {
        const tasks = [task('c'), task('a'), task('b')];
        const { unrated } = partitionByCommitment(tasks, {}, BENCHMARKS, NOW);

        expect(ids(unrated)).toEqual(['c', 'a', 'b']);
    });

    it('keeps pinned tasks in the incoming order too', () => {
        const tasks = [task('c'), task('a'), task('b')];
        const pinnedCard = card({ hardConstraints: ['compliance'] });
        const { pinned } = partitionByCommitment(
            tasks,
            { a: pinnedCard, b: pinnedCard, c: pinnedCard },
            BENCHMARKS,
            NOW,
        );

        expect(ids(pinned)).toEqual(['c', 'a', 'b']);
    });

    it('moves a card with a missing benchmark into unrated rather than ranking it', () => {
        const tasks = [task('orphan')];
        const { pinned, rated, unrated } = partitionByCommitment(
            tasks,
            { orphan: card({ benchmarkId: 'deleted' }) },
            BENCHMARKS,
            NOW,
        );

        expect(ids(pinned)).toEqual([]);
        expect(ids(rated)).toEqual([]);
        expect(ids(unrated)).toEqual(['orphan']);
    });

    it('exposes the score for every rated task', () => {
        const { scores } = partitionByCommitment(
            [task('a')],
            { a: card({ goalPerf: 3, goalCap: 1, impact: 3, delegable: 3 }) },
            BENCHMARKS,
            NOW,
        );

        expect(scores.a).toMatchObject({ goal: 3, urgency: 1, value: 10, complexity: 1, p: 10 });
    });

    it('returns empty bands for an empty list', () => {
        const result = partitionByCommitment([], {}, BENCHMARKS, NOW);
        expect(result.pinned).toEqual([]);
        expect(result.rated).toEqual([]);
        expect(result.unrated).toEqual([]);
        expect(result.scores).toEqual({});
    });
});
