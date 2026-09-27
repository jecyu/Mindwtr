/**
 * The one-line justification: why this task sits where it does.
 *
 * A P-value on its own is a number with no argument behind it, which is the
 * problem this feature exists to solve — the ranking has to be explainable to
 * be worth trusting. The text is derived from the same score object the
 * breakdown view renders, so the sentence and the arithmetic cannot disagree.
 *
 * Interpolation goes through resolveI18nText rather than tFallback: the
 * sentence has to survive translation, and a locale that reorders its clauses
 * cannot do that with concatenated fragments.
 */

import type { CommitmentBenchmark, CommitmentCard } from './commitment-types';
import type { CommitmentScore } from './commitment-score';
import { resolveI18nText, type TranslateFn } from './i18n';

export type CommitmentReasonMode = 'long' | 'short';

export interface CommitmentReasonInput {
    taskTitle: string;
    card: CommitmentCard;
    score: CommitmentScore;
    benchmark: CommitmentBenchmark | undefined;
}

/** Which long-term goal the card scored highest, as an i18n key suffix. */
function goalDimension(card: CommitmentCard): 'perf' | 'cap' {
    return card.goalPerf >= card.goalCap ? 'perf' : 'cap';
}

function goalLevelKey(level: number): string {
    if (level >= 3) return 'direct';
    if (level === 2) return 'support';
    return 'none';
}

function impactKey(level: number): string {
    if (level >= 3) return 'major';
    if (level === 2) return 'normal';
    return 'minor';
}

function delegableKey(level: number): string {
    if (level >= 3) return 'must';
    if (level === 2) return 'partial';
    return 'any';
}

/**
 * Labels are resolved through the same `t` the panel uses, so a missing
 * translation falls back to English rather than to a raw key mid-sentence.
 */
function buildValues(input: CommitmentReasonInput, t: TranslateFn): Record<string, string | number> {
    const { card, score, benchmark } = input;
    return {
        goal: resolveI18nText(t, `pledge.goal.${goalDimension(card)}`, { fallback: goalDimension(card) === 'perf' ? 'performance' : 'skills' }),
        goalLevel: resolveI18nText(t, `pledge.level.${goalLevelKey(score.goal)}`, { fallback: goalLevelKey(score.goal) }),
        impact: resolveI18nText(t, `pledge.impact.${impactKey(score.impact)}`, { fallback: impactKey(score.impact) }),
        delegable: resolveI18nText(t, `pledge.delegable.${delegableKey(score.delegable)}`, { fallback: delegableKey(score.delegable) }),
        tier: resolveI18nText(t, `pledge.tier.${card.targetTier}`, { fallback: card.targetTier }),
        benchmark: benchmark?.name ?? resolveI18nText(t, 'pledge.noBenchmark', { fallback: 'no benchmark' }),
        multiplier: card.multiplier,
        value: score.value,
        complexity: score.complexity,
        p: score.p.toFixed(2),
        task: input.taskTitle,
    };
}

export function buildCommitmentReason(
    input: CommitmentReasonInput,
    t: TranslateFn,
    mode: CommitmentReasonMode = 'long',
): string {
    const values = buildValues(input, t);

    if (mode === 'short') {
        return resolveI18nText(t, 'pledge.reason.short', {
            fallback: 'P {p} — {benchmark} × {multiplier}, aiming at {tier}.',
            values,
        });
    }

    return resolveI18nText(t, 'pledge.reason.long', {
        fallback: 'It moves {goal} at {goalLevel}, lands {impact}, and is {delegable}. '
            + 'Value {value} ÷ complexity {complexity} (a {benchmark} × {multiplier}) = P {p}, aiming at {tier}.',
        values,
    });
}
