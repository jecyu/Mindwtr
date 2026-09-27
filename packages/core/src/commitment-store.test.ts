import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARKS, normalizeCommitmentBenchmark, normalizeCommitmentCard } from './commitment-types';
import {
    readCommitmentBenchmarks,
    readCommitmentCard,
    readCommitmentCards,
    withCommitmentBenchmark,
    withCommitmentCard,
    withoutCommitmentBenchmark,
    withoutCommitmentCard,
} from './commitment-store';
import type { AppSettings } from './types';

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({ ...overrides });

const card = (overrides = {}) => ({
    goalPerf: 3,
    goalCap: 2,
    impact: 3,
    delegable: 3,
    hardConstraints: [],
    isHardDeadline: false,
    benchmarkId: 'bench',
    multiplier: 1,
    targetTier: 'good',
    milestones: [],
    ...overrides,
});

describe('normalizeCommitmentCard', () => {
    it('fills every field when the row is empty', () => {
        // A half-written row must not reach the score as undefined — that turns
        // the P-value into NaN, which sorts unpredictably.
        expect(normalizeCommitmentCard({})).toEqual({
            goalPerf: 1,
            goalCap: 1,
            impact: 1,
            delegable: 1,
            hardConstraints: [],
            isHardDeadline: false,
            benchmarkId: '',
            multiplier: 1,
            targetTier: 'pass',
            milestones: [],
            reasonSnapshot: undefined,
        });
    });

    it('rejects values outside the allowed sets instead of trusting them', () => {
        const card = normalizeCommitmentCard({
            goalPerf: 99,
            impact: 0,
            multiplier: 7,
            targetTier: 'perfect',
        });
        expect(card).toMatchObject({ goalPerf: 1, impact: 1, multiplier: 1, targetTier: 'pass' });
    });

    it('drops unknown hard constraints but keeps the known ones', () => {
        const card = normalizeCommitmentCard({ hardConstraints: ['health', 'vibes', 'compliance'] });
        expect(card!.hardConstraints).toEqual(['health', 'compliance']);
    });

    it('keeps only well-formed milestones', () => {
        const card = normalizeCommitmentCard({
            milestones: [
                { id: 'm1', title: 'Draft', status: 'doing', progress: 40 },
                { id: 'm2' }, // no title
                'nonsense',
            ],
        });
        expect(card!.milestones).toEqual([
            { id: 'm1', title: 'Draft', targetDate: undefined, status: 'doing', progress: 40, actualHours: undefined },
        ]);
    });

    it('clamps milestone progress into 0-100', () => {
        const card = normalizeCommitmentCard({
            milestones: [{ id: 'm1', title: 'Draft', progress: 480 }],
        });
        expect(card!.milestones[0].progress).toBe(100);
    });

    it('returns null for anything that is not an object', () => {
        expect(normalizeCommitmentCard(null)).toBeNull();
        expect(normalizeCommitmentCard('card')).toBeNull();
        expect(normalizeCommitmentCard(42)).toBeNull();
    });
});

describe('normalizeCommitmentBenchmark', () => {
    it('rejects a benchmark with no usable divisor', () => {
        expect(normalizeCommitmentBenchmark({ id: 'b', name: 'B', points: 0 })).toBeNull();
        expect(normalizeCommitmentBenchmark({ id: 'b', name: 'B', points: -1 })).toBeNull();
        expect(normalizeCommitmentBenchmark({ id: 'b', name: 'B' })).toBeNull();
    });

    it('rejects one with no id or name', () => {
        expect(normalizeCommitmentBenchmark({ name: 'B', points: 1 })).toBeNull();
        expect(normalizeCommitmentBenchmark({ id: 'b', points: 1 })).toBeNull();
    });
});

describe('readCommitmentCards', () => {
    it('reads back what was written', () => {
        const next = withCommitmentCard(settings(), 't1', card());
        expect(readCommitmentCards(next).t1).toMatchObject({ goalPerf: 3, impact: 3 });
    });

    it('returns an empty map when nothing is stored', () => {
        expect(readCommitmentCards(settings())).toEqual({});
        expect(readCommitmentCards(undefined)).toEqual({});
    });

    it('drops unusable entries rather than throwing', () => {
        const broken = settings({ commitmentCards: { good: card(), bad: null } as never });
        expect(Object.keys(readCommitmentCards(broken))).toEqual(['good']);
    });

    it('normalizes on read, so a hand-edited blob cannot poison the score', () => {
        const handEdited = settings({ commitmentCards: { t1: { goalPerf: 3 } } as never });
        expect(readCommitmentCards(handEdited).t1).toMatchObject({ goalPerf: 3, impact: 1, delegable: 1 });
    });
});

describe('readCommitmentCard', () => {
    it('finds one card by id', () => {
        const next = withCommitmentCard(settings(), 't1', card({ impact: 2 }));
        expect(readCommitmentCard(next, 't1')).toMatchObject({ impact: 2 });
        expect(readCommitmentCard(next, 'missing')).toBeNull();
    });
});

describe('withoutCommitmentCard', () => {
    it('removes just that card', () => {
        const two = withCommitmentCard(withCommitmentCard(settings(), 't1', card()), 't2', card());
        const one = withoutCommitmentCard(two, 't1');
        expect(Object.keys(readCommitmentCards(one))).toEqual(['t2']);
    });

    it('returns the same settings object when there is nothing to remove', () => {
        // Identity matters: the store compares references to decide whether to
        // schedule a save.
        const original = settings();
        expect(withoutCommitmentCard(original, 'nope')).toBe(original);
    });
});

describe('readCommitmentBenchmarks', () => {
    it('seeds the defaults when the key has never been written', () => {
        expect(readCommitmentBenchmarks(settings())).toEqual([...DEFAULT_BENCHMARKS]);
        expect(readCommitmentBenchmarks(undefined)).toEqual([...DEFAULT_BENCHMARKS]);
    });

    it('respects an empty array as "the user deleted them all"', () => {
        // Collapsing absent and empty into one would resurrect deleted rows.
        expect(readCommitmentBenchmarks(settings({ commitmentBenchmarks: [] }))).toEqual([]);
    });

    it('drops rows with an unusable divisor', () => {
        const broken = settings({
            commitmentBenchmarks: [
                { id: 'ok', name: 'Ok', points: 2 },
                { id: 'zero', name: 'Zero', points: 0 },
            ] as never,
        });
        expect(readCommitmentBenchmarks(broken).map((entry) => entry.id)).toEqual(['ok']);
    });
});

describe('withCommitmentBenchmark', () => {
    it('replaces by id', () => {
        const seeded = settings({ commitmentBenchmarks: [...DEFAULT_BENCHMARKS] });
        const next = withCommitmentBenchmark(seeded, { id: 'weekly-report', name: 'Renamed', points: 9 });
        const stored = readCommitmentBenchmarks(next);
        expect(stored).toHaveLength(DEFAULT_BENCHMARKS.length);
        expect(stored.find((entry) => entry.id === 'weekly-report')).toMatchObject({ name: 'Renamed', points: 9 });
    });

    it('appends a new id', () => {
        const next = withCommitmentBenchmark(settings({ commitmentBenchmarks: [] }), { id: 'new', name: 'New', points: 4 });
        expect(readCommitmentBenchmarks(next)).toHaveLength(1);
    });
});

describe('withoutCommitmentBenchmark', () => {
    it('removes by id and keeps the rest', () => {
        const next = withoutCommitmentBenchmark(settings(), 'weekly-report');
        const stored = readCommitmentBenchmarks(next);
        expect(stored).toHaveLength(DEFAULT_BENCHMARKS.length - 1);
        expect(stored.some((entry) => entry.id === 'weekly-report')).toBe(false);
    });

    it('leaves the seeded defaults untouched when the id is unknown', () => {
        expect(readCommitmentBenchmarks(withoutCommitmentBenchmark(settings(), 'nope')))
            .toEqual([...DEFAULT_BENCHMARKS]);
    });
});
