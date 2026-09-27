import { useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import {
    readCommitmentBenchmarks,
    tFallback,
    useTaskStore,
    withCommitmentBenchmark,
    withoutCommitmentBenchmark,
    type CommitmentBenchmark,
} from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { useLanguage } from '../../../contexts/language-context';

/**
 * The anchor library the P-value divides by.
 *
 * Editable here rather than only through the JSON, because the whole point of
 * a benchmark is that it tracks your own estimates — a library nobody updates
 * is just a constant, and the P-value quietly stops meaning anything.
 *
 * `points` is the divisor, so it has to stay positive; the store normalizer
 * drops a row that is not, and this refuses to save one in the first place.
 */

const FIELDS = ['name', 'points', 'p50', 'p80', 'dod'] as const;
type FieldKey = (typeof FIELDS)[number];

const emptyDraft = (): CommitmentBenchmark => ({
    id: `bench-${Date.now().toString(36)}`,
    name: '',
    points: 1,
    p50: '',
    p80: '',
    dod: '',
});

export function SettingsCommitmentBenchmarksSection() {
    const { t } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const updateSettings = useTaskStore((state) => state.updateSettings);

    const benchmarks = readCommitmentBenchmarks(settings);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<CommitmentBenchmark | null>(null);

    const persist = (next: CommitmentBenchmark[]) => {
        void updateSettings({ commitmentBenchmarks: next });
    };

    const startEdit = (benchmark: CommitmentBenchmark) => {
        setEditingId(benchmark.id);
        setDraft({ ...benchmark });
    };

    const commit = () => {
        if (!draft || !draft.name.trim() || !(draft.points > 0)) return;
        persist(withCommitmentBenchmark(settings, { ...draft, name: draft.name.trim() }).commitmentBenchmarks ?? []);
        setEditingId(null);
        setDraft(null);
    };

    const remove = (id: string) => {
        persist(withoutCommitmentBenchmark(settings, id).commitmentBenchmarks ?? []);
        if (editingId === id) {
            setEditingId(null);
            setDraft(null);
        }
    };

    const add = () => {
        const next = emptyDraft();
        setEditingId(next.id);
        setDraft(next);
    };

    const inputClass = 'w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground';

    const renderRow = (benchmark: CommitmentBenchmark) => {
        const editing = editingId === benchmark.id && draft !== null;
        const value = editing ? draft : benchmark;

        const set = (key: FieldKey, raw: string) => {
            if (!draft) return;
            setDraft({ ...draft, [key]: key === 'points' ? Number(raw) : raw });
        };

        return (
            <div
                key={benchmark.id}
                data-testid={`commitment-benchmark-${benchmark.id}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5"
            >
                {editing ? (
                    <>
                        <input
                            aria-label={tFallback(t, 'pledge.benchmark.name', 'Name')}
                            className={cn(inputClass, 'min-w-[10rem] flex-1')}
                            value={value.name}
                            onChange={(event) => set('name', event.target.value)}
                        />
                        <input
                            aria-label={tFallback(t, 'pledge.benchmark.points', 'Points')}
                            className={cn(inputClass, 'w-16')}
                            type="number"
                            min={0.5}
                            step={0.5}
                            value={value.points}
                            onChange={(event) => set('points', event.target.value)}
                        />
                        <input
                            aria-label={tFallback(t, 'pledge.p50', 'P50')}
                            className={cn(inputClass, 'w-20')}
                            value={value.p50 ?? ''}
                            onChange={(event) => set('p50', event.target.value)}
                        />
                        <input
                            aria-label={tFallback(t, 'pledge.p80', 'P80')}
                            className={cn(inputClass, 'w-20')}
                            value={value.p80 ?? ''}
                            onChange={(event) => set('p80', event.target.value)}
                        />
                        <input
                            aria-label={tFallback(t, 'pledge.benchmark.dod', 'Done looks like')}
                            className={cn(inputClass, 'min-w-[10rem] flex-1')}
                            value={value.dod ?? ''}
                            onChange={(event) => set('dod', event.target.value)}
                        />
                        <button
                            type="button"
                            aria-label={tFallback(t, 'common.save', 'Save')}
                            onClick={commit}
                            className="rounded p-1 text-success hover:bg-muted"
                        >
                            <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                            type="button"
                            aria-label={tFallback(t, 'common.cancel', 'Cancel')}
                            onClick={() => { setEditingId(null); setDraft(null); }}
                            className="rounded p-1 text-muted-foreground hover:bg-muted"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </>
                ) : (
                    <>
                        <span className="text-sm font-medium text-foreground">{benchmark.name}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                            {benchmark.points}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                            {tFallback(t, 'pledge.p50', 'P50')} {benchmark.p50 || '—'}
                            {' · '}
                            {tFallback(t, 'pledge.p80', 'P80')} {benchmark.p80 || '—'}
                        </span>
                        {benchmark.dod && (
                            <span className="truncate text-xs text-muted-foreground">{benchmark.dod}</span>
                        )}
                        <button
                            type="button"
                            aria-label={tFallback(t, 'common.edit', 'Edit')}
                            onClick={() => startEdit(benchmark)}
                            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                            type="button"
                            aria-label={tFallback(t, 'common.delete', 'Delete')}
                            onClick={() => remove(benchmark.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-2">
            {benchmarks.map(renderRow)}

            {editingId !== null && draft && !benchmarks.some((entry) => entry.id === draft.id) && renderRow(draft)}

            <button
                type="button"
                onClick={add}
                className="rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
                {tFallback(t, 'pledge.benchmark.add', '+ New benchmark')}
            </button>
        </div>
    );
}
