import { describe, expect, it } from 'vitest';
import type { CommitmentBenchmark, CommitmentCard } from './commitment-types';
import { computeCommitmentScore, deriveUrgency, hasHardConstraint } from './commitment-score';

// Local-time construction on both sides keeps these assertions independent of
// the machine's timezone — an ISO string would not.
const NOW = new Date(2026, 8, 27, 10, 0, 0); // 2026-09-27 10:00 local
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
    new Date(y, m - 1, d, h, min, 0).toISOString();

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

const benchmark = (points: number): CommitmentBenchmark => ({
    id: 'bench',
    name: 'Bench',
    points,
});

describe('deriveUrgency', () => {
    it('treats the 48h boundary as still urgent', () => {
        const due = new Date(NOW.getTime() + 48 * 3_600_000).toISOString();
        expect(deriveUrgency(due, NOW)).toEqual({ value: 3, reason: 'within-48h' });
    });

    it('drops to this-week one millisecond past 48h', () => {
        const due = new Date(NOW.getTime() + 48 * 3_600_000 + 1).toISOString();
        expect(deriveUrgency(due, NOW)).toEqual({ value: 2, reason: 'this-week' });
    });

    it('treats the 168h boundary as still this-week', () => {
        const due = new Date(NOW.getTime() + 168 * 3_600_000).toISOString();
        expect(deriveUrgency(due, NOW)).toEqual({ value: 2, reason: 'this-week' });
    });

    it('drops to no-deadline past a week', () => {
        const due = new Date(NOW.getTime() + 168 * 3_600_000 + 1).toISOString();
        expect(deriveUrgency(due, NOW)).toEqual({ value: 1, reason: 'no-deadline' });
    });

    it('scores an overdue date as the top urgency — that is what makes it climb', () => {
        const due = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
        expect(deriveUrgency(due, NOW)).toEqual({ value: 3, reason: 'within-48h' });
    });

    it('treats a missing or unparseable date as no deadline', () => {
        expect(deriveUrgency(undefined, NOW).reason).toBe('no-deadline');
        expect(deriveUrgency('not a date', NOW).reason).toBe('no-deadline');
    });
});

describe('computeCommitmentScore', () => {
    // The worked examples from the design doc, so the arithmetic is pinned to
    // something a human has already checked by hand.
    it('matches the hand-computed samples', () => {
        const weekly = computeCommitmentScore(
            { dueDate: at(2026, 9, 27, 18) }, // 8h out -> 3
            card({ goalPerf: 2, goalCap: 1, impact: 1, delegable: 1 }),
            benchmark(1),
            NOW,
        );
        expect(weekly).toMatchObject({ goal: 2, urgency: 3, value: 7, complexity: 1, p: 7 });

        const q3 = computeCommitmentScore(
            { dueDate: at(2026, 9, 29, 12) }, // 50h out -> 2
            card({ goalPerf: 3, goalCap: 2, impact: 3, delegable: 3 }),
            benchmark(5),
            NOW,
        );
        expect(q3).toMatchObject({ goal: 3, urgency: 2, value: 11, complexity: 5 });
        expect(q3!.p).toBeCloseTo(2.2, 10);

        const proposal = computeCommitmentScore(
            { dueDate: at(2026, 10, 2, 18) }, // 128h out -> 2
            card({ goalPerf: 3, goalCap: 1, impact: 3, delegable: 2 }),
            benchmark(3),
            NOW,
        );
        expect(proposal).toMatchObject({ goal: 3, urgency: 2, value: 10, complexity: 3 });
        expect(proposal!.p).toBeCloseTo(10 / 3, 10);

        const template = computeCommitmentScore(
            { dueDate: undefined }, // no date -> 1
            card({ goalPerf: 1, goalCap: 3, impact: 1, delegable: 3, multiplier: 2 }),
            benchmark(2),
            NOW,
        );
        expect(template).toMatchObject({ goal: 3, urgency: 1, value: 8, complexity: 4, p: 2 });
    });

    it('takes the stronger of the two long-term goals', () => {
        const career = computeCommitmentScore({ dueDate: undefined }, card({ goalPerf: 3, goalCap: 1 }), benchmark(1), NOW);
        const skill = computeCommitmentScore({ dueDate: undefined }, card({ goalPerf: 1, goalCap: 3 }), benchmark(1), NOW);
        expect(career!.goal).toBe(3);
        expect(skill!.goal).toBe(3);
    });

    it('refuses to score a card whose benchmark is gone', () => {
        expect(computeCommitmentScore({ dueDate: undefined }, card(), undefined, NOW)).toBeNull();
    });

    it('refuses to score a zero-point benchmark instead of dividing by it', () => {
        expect(computeCommitmentScore({ dueDate: undefined }, card(), benchmark(0), NOW)).toBeNull();
        expect(computeCommitmentScore({ dueDate: undefined }, card(), benchmark(-1), NOW)).toBeNull();
    });

    it('refuses a non-finite benchmark', () => {
        expect(computeCommitmentScore({ dueDate: undefined }, card(), benchmark(Number.NaN), NOW)).toBeNull();
        expect(computeCommitmentScore({ dueDate: undefined }, card(), benchmark(Number.POSITIVE_INFINITY), NOW)).toBeNull();
    });

    it('scales the divisor by the complexity multiplier', () => {
        const simpler = computeCommitmentScore({ dueDate: undefined }, card({ multiplier: 0.5 }), benchmark(4), NOW);
        const harder = computeCommitmentScore({ dueDate: undefined }, card({ multiplier: 2 }), benchmark(4), NOW);
        expect(simpler!.complexity).toBe(2);
        expect(harder!.complexity).toBe(8);
        expect(simpler!.p).toBeGreaterThan(harder!.p);
    });
});

describe('hasHardConstraint', () => {
    it('is false for a missing card and for an empty list', () => {
        expect(hasHardConstraint(undefined)).toBe(false);
        expect(hasHardConstraint(card({ hardConstraints: [] }))).toBe(false);
    });

    it('is true once anything is pinned', () => {
        expect(hasHardConstraint(card({ hardConstraints: ['health'] }))).toBe(true);
    });
});
