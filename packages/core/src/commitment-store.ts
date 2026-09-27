/**
 * Commitment storage, expressed as pure transforms over AppSettings.
 *
 * The cards ride in settings (see the AppSettings comment in types.ts for why),
 * so there is nothing to await here: the caller already holds the settings
 * object and writes the result back through its normal save path. An async
 * store interface would only be wrapping that in a promise.
 *
 * Every read normalizes, because settings is a JSON blob that a hand-edit or an
 * older build can leave half-shaped — a card with a missing `impact` would
 * reach the score as undefined and turn the whole P-value into NaN.
 */

import {
    DEFAULT_BENCHMARKS,
    normalizeCommitmentBenchmark,
    normalizeCommitmentCard,
    type CommitmentBenchmark,
    type CommitmentCard,
} from './commitment-types';
import type { AppSettings } from './types';

/** Cards by task id, with unusable entries dropped rather than thrown on. */
export function readCommitmentCards(settings: AppSettings | undefined): Record<string, CommitmentCard> {
    const stored = settings?.commitmentCards;
    if (!stored || typeof stored !== 'object') return {};

    const cards: Record<string, CommitmentCard> = {};
    for (const [taskId, value] of Object.entries(stored)) {
        const card = normalizeCommitmentCard(value);
        if (card) cards[taskId] = card;
    }
    return cards;
}

export function readCommitmentCard(
    settings: AppSettings | undefined,
    taskId: string,
): CommitmentCard | null {
    return normalizeCommitmentCard(settings?.commitmentCards?.[taskId]);
}

/**
 * An absent key means "never seeded" and yields the defaults; an empty array
 * means the user deleted them all and stays empty. Collapsing those two into
 * one would resurrect benchmarks the user removed.
 */
export function readCommitmentBenchmarks(settings: AppSettings | undefined): CommitmentBenchmark[] {
    const stored = settings?.commitmentBenchmarks;
    if (!Array.isArray(stored)) return [...DEFAULT_BENCHMARKS];

    return stored.flatMap((entry) => {
        const benchmark = normalizeCommitmentBenchmark(entry);
        return benchmark ? [benchmark] : [];
    });
}

export function withCommitmentCard(
    settings: AppSettings,
    taskId: string,
    card: CommitmentCard,
): AppSettings {
    return {
        ...settings,
        commitmentCards: { ...settings.commitmentCards, [taskId]: card },
    };
}

export function withoutCommitmentCard(settings: AppSettings, taskId: string): AppSettings {
    if (!settings.commitmentCards || !(taskId in settings.commitmentCards)) return settings;

    const { [taskId]: _removed, ...rest } = settings.commitmentCards;
    return { ...settings, commitmentCards: rest };
}

/** Replaces by id, or appends when the id is new. */
export function withCommitmentBenchmark(
    settings: AppSettings,
    benchmark: CommitmentBenchmark,
): AppSettings {
    const current = readCommitmentBenchmarks(settings);
    const index = current.findIndex((entry) => entry.id === benchmark.id);
    const next = index === -1
        ? [...current, benchmark]
        : current.map((entry) => (entry.id === benchmark.id ? benchmark : entry));

    return { ...settings, commitmentBenchmarks: next };
}

export function withoutCommitmentBenchmark(settings: AppSettings, id: string): AppSettings {
    const next = readCommitmentBenchmarks(settings).filter((entry) => entry.id !== id);
    return { ...settings, commitmentBenchmarks: next };
}
