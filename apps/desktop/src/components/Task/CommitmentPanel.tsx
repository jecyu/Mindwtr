import { useMemo } from 'react';
import { Flag, Gauge, Trash2 } from 'lucide-react';
import {
    buildCommitmentReason,
    computeCommitmentScore,
    readCommitmentBenchmarks,
    readCommitmentCard,
    tFallback,
    useTaskStore,
    withCommitmentCard,
    withoutCommitmentCard,
    type CommitmentCard,
} from '@mindwtr/core';

import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { PillOptionField, type PillOption } from './fields/TaskMetadataFields';
import { TaskEditorFieldLabel } from './task-editor-label';

/**
 * The commitment assessment for one task, as a panel in the task editor.
 *
 * It reads and writes settings directly rather than joining the editor's draft.
 * The card is not a Task field — it lives in device-local settings keyed by task
 * id — so it cannot ride the draft the rest of the form commits on Save. The
 * consequence is deliberate and worth knowing: edits here persist immediately,
 * and cancelling the task edit does not roll them back.
 *
 * A task with no card shows the defaults as a starting point but stays
 * unassessed until the first edit, so opening the panel never silently scores
 * something.
 */

type LevelValue = '3' | '2' | '1';
type MultiplierValue = '0.5' | '1' | '2';

const DEFAULT_CARD: CommitmentCard = {
    goalPerf: 2,
    goalCap: 2,
    impact: 2,
    delegable: 3,
    hardConstraints: [],
    isHardDeadline: false,
    benchmarkId: '',
    multiplier: 1,
    targetTier: 'pass',
    milestones: [],
};

const HARD_CONSTRAINTS: CommitmentCard['hardConstraints'] = [
    'health',
    'family',
    'compliance',
    'external-deadline',
    'critical-path',
];

/**
 * The three-tier control every scored field uses. Labels come in as explicit
 * keys rather than a shared suffix, because the three tiers mean different
 * things per field — direct/support/none for a goal, major/normal/minor for
 * impact — and they must be the same keys the reason sentence reads.
 */
const levelOptions = (
    t: (key: string) => string,
    keys: readonly [string, string, string],
    fallbacks: readonly [string, string, string],
): Array<PillOption<LevelValue>> => [
    { value: '3', label: tFallback(t, keys[0], fallbacks[0]) },
    { value: '2', label: tFallback(t, keys[1], fallbacks[1]) },
    { value: '1', label: tFallback(t, keys[2], fallbacks[2]) },
];

const GOAL_LEVEL_KEYS = ['pledge.level.direct', 'pledge.level.support', 'pledge.level.none'] as const;
const GOAL_LEVEL_FALLBACKS = ['Direct', 'Supporting', 'None'] as const;
const IMPACT_KEYS = ['pledge.impact.major', 'pledge.impact.normal', 'pledge.impact.minor'] as const;
const IMPACT_FALLBACKS = ['Major', 'Normal', 'Minor'] as const;
const DELEGABLE_KEYS = ['pledge.delegable.must', 'pledge.delegable.partial', 'pledge.delegable.any'] as const;
const DELEGABLE_FALLBACKS = ['Must be me', 'Partly delegable', 'Fully delegable'] as const;

export function CommitmentPanel({
    taskId,
    dueDate,
}: {
    taskId: string;
    dueDate?: string;
}) {
    const { t } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const updateSettings = useTaskStore((state) => state.updateSettings);

    const stored = readCommitmentCard(settings, taskId);
    const benchmarks = useMemo(() => readCommitmentBenchmarks(settings), [settings]);
    const card = stored ?? DEFAULT_CARD;

    const benchmark = benchmarks.find((entry) => entry.id === card.benchmarkId);
    const score = computeCommitmentScore({ dueDate }, card, benchmark, new Date());
    const reason = score
        ? buildCommitmentReason({ taskTitle: '', card, score, benchmark }, t, 'long')
        : null;

    const patch = (change: Partial<CommitmentCard>) => {
        void updateSettings({ commitmentCards: withCommitmentCard(settings, taskId, { ...card, ...change }).commitmentCards });
    };

    const clear = () => {
        void updateSettings({ commitmentCards: withoutCommitmentCard(settings, taskId).commitmentCards });
    };

    // "External deadline" is the one hard constraint that has to agree with a
    // date on the task; the rest stand on their own.
    const needsDueDate = card.hardConstraints.includes('external-deadline') && !dueDate;

    const toggleConstraint = (constraint: CommitmentCard['hardConstraints'][number]) => {
        const next = card.hardConstraints.includes(constraint)
            ? card.hardConstraints.filter((entry) => entry !== constraint)
            : [...card.hardConstraints, constraint];
        patch({ hardConstraints: next });
    };

    return (
        <div className="space-y-4 rounded-lg border border-dashed border-primary/40 bg-primary/[0.03] p-4">
            <div className="flex items-center gap-2">
                <TaskEditorFieldLabel icon={Gauge}>
                    {tFallback(t, 'pledge.title', 'Commitment')}
                </TaskEditorFieldLabel>
                {!stored && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {tFallback(t, 'pledge.notAssessed', 'Not assessed')}
                    </span>
                )}
                {stored && (
                    <button
                        type="button"
                        onClick={clear}
                        aria-label={tFallback(t, 'pledge.clear', 'Clear assessment')}
                        className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            <PillOptionField<LevelValue>
                t={t}
                ariaLabel={tFallback(t, 'pledge.goalPerf', 'Long-term goal: performance')}
                label={tFallback(t, 'pledge.goalPerf', 'Long-term goal: performance')}
                options={levelOptions(t, GOAL_LEVEL_KEYS, GOAL_LEVEL_FALLBACKS)}
                value={String(card.goalPerf) as LevelValue}
                onChange={(value) => patch({ goalPerf: Number(value) as CommitmentCard['goalPerf'] })}
            />

            <PillOptionField<LevelValue>
                t={t}
                ariaLabel={tFallback(t, 'pledge.goalCap', 'Long-term goal: skills')}
                label={tFallback(t, 'pledge.goalCap', 'Long-term goal: skills')}
                options={levelOptions(t, GOAL_LEVEL_KEYS, GOAL_LEVEL_FALLBACKS)}
                value={String(card.goalCap) as LevelValue}
                onChange={(value) => patch({ goalCap: Number(value) as CommitmentCard['goalCap'] })}
            />

            <PillOptionField<LevelValue>
                t={t}
                ariaLabel={tFallback(t, 'pledge.impact', 'Impact')}
                label={tFallback(t, 'pledge.impact', 'Impact')}
                options={levelOptions(t, IMPACT_KEYS, IMPACT_FALLBACKS)}
                value={String(card.impact) as LevelValue}
                onChange={(value) => patch({ impact: Number(value) as CommitmentCard['impact'] })}
            />

            <PillOptionField<LevelValue>
                t={t}
                ariaLabel={tFallback(t, 'pledge.delegable', 'Could someone else do this')}
                label={tFallback(t, 'pledge.delegable', 'Could someone else do this')}
                options={levelOptions(t, DELEGABLE_KEYS, DELEGABLE_FALLBACKS)}
                value={String(card.delegable) as LevelValue}
                onChange={(value) => patch({ delegable: Number(value) as CommitmentCard['delegable'] })}
            />

            <div>
                <TaskEditorFieldLabel icon={Flag}>
                    {tFallback(t, 'pledge.hardConstraints', 'Hard constraints')}
                </TaskEditorFieldLabel>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {HARD_CONSTRAINTS.map((constraint) => {
                        const active = card.hardConstraints.includes(constraint);
                        return (
                            <button
                                key={constraint}
                                type="button"
                                aria-pressed={active}
                                onClick={() => toggleConstraint(constraint)}
                                className={cn(
                                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                                    active
                                        ? 'border-destructive bg-destructive/10 text-destructive'
                                        : 'border-border text-muted-foreground hover:bg-muted',
                                )}
                            >
                                {tFallback(t, `pledge.constraint.${constraint}`, constraint)}
                            </button>
                        );
                    })}
                </div>
                {needsDueDate && (
                    <p className="mt-1.5 text-xs text-destructive">
                        {tFallback(t, 'pledge.needsDueDate', 'An external deadline needs a due date on the task.')}
                    </p>
                )}
            </div>

            <PillOptionField<'yes' | 'no'>
                t={t}
                ariaLabel={tFallback(t, 'pledge.isHardDeadline', 'Non-negotiable deadline')}
                label={tFallback(t, 'pledge.isHardDeadline', 'Non-negotiable deadline')}
                options={[
                    { value: 'yes', label: tFallback(t, 'pledge.yes', 'Yes') },
                    { value: 'no', label: tFallback(t, 'pledge.no', 'No') },
                ]}
                value={card.isHardDeadline ? 'yes' : 'no'}
                onChange={(value) => patch({ isHardDeadline: value === 'yes' })}
            />

            <div>
                <TaskEditorFieldLabel icon={Gauge}>
                    {tFallback(t, 'pledge.benchmark', 'Benchmark')}
                </TaskEditorFieldLabel>
                <select
                    aria-label={tFallback(t, 'pledge.benchmark', 'Benchmark')}
                    value={card.benchmarkId}
                    onChange={(event) => patch({ benchmarkId: event.target.value })}
                    className="mt-1.5 w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
                >
                    <option value="">{tFallback(t, 'pledge.noBenchmark', 'Not set')}</option>
                    {benchmarks.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                            {entry.name} ({entry.points})
                        </option>
                    ))}
                </select>
                {benchmark && (
                    <p className="mt-1 text-xs text-muted-foreground">
                        {tFallback(t, 'pledge.p50', 'P50')} {benchmark.p50 ?? '—'} ·{' '}
                        {tFallback(t, 'pledge.p80', 'P80')} {benchmark.p80 ?? '—'}
                    </p>
                )}
            </div>

            <PillOptionField<MultiplierValue>
                t={t}
                ariaLabel={tFallback(t, 'pledge.multiplier', 'How this run compares')}
                label={tFallback(t, 'pledge.multiplier', 'How this run compares')}
                options={[
                    { value: '0.5', label: tFallback(t, 'pledge.multiplier.simpler', 'Simpler') },
                    { value: '1', label: tFallback(t, 'pledge.multiplier.typical', 'Typical') },
                    { value: '2', label: tFallback(t, 'pledge.multiplier.harder', 'Harder') },
                ]}
                value={String(card.multiplier) as MultiplierValue}
                onChange={(value) => patch({ multiplier: Number(value) as CommitmentCard['multiplier'] })}
            />

            <PillOptionField<CommitmentCard['targetTier']>
                t={t}
                ariaLabel={tFallback(t, 'pledge.targetTier', 'Delivery bar')}
                label={tFallback(t, 'pledge.targetTier', 'Delivery bar')}
                options={[
                    { value: 'pass', label: tFallback(t, 'pledge.tier.pass', 'Pass') },
                    { value: 'good', label: tFallback(t, 'pledge.tier.good', 'Good') },
                    { value: 'excellent', label: tFallback(t, 'pledge.tier.excellent', 'Excellent') },
                ]}
                value={card.targetTier}
                onChange={(value) => patch({ targetTier: value })}
            />

            <div className="rounded-md bg-muted/60 p-3">
                {score ? (
                    <>
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-xs text-muted-foreground">
                                {tFallback(t, 'pledge.formula', 'P = value ÷ complexity')} = {score.value} ÷ {score.complexity}
                            </span>
                            <span className="text-lg font-bold tabular-nums text-foreground">{score.p.toFixed(2)}</span>
                        </div>
                        {reason && (
                            <p className="mt-2 border-l-2 border-primary pl-2 text-xs leading-relaxed text-muted-foreground">
                                {reason}
                            </p>
                        )}
                    </>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        {tFallback(t, 'pledge.noScore', 'Pick a benchmark to score this task.')}
                    </p>
                )}
            </div>
        </div>
    );
}
