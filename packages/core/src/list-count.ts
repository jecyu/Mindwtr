import { tFallback } from './i18n';

/** A localized noun with its count for list headers and action toasts. */
export function formatListItemCount(count: number, kind: 'task' | 'project' | 'event', t: (key: string) => string): string {
    return `${count} ${formatListItemCountNoun(count, kind, t)}`;
}

export function formatListItemCountNoun(count: number, kind: 'task' | 'project' | 'event', t: (key: string) => string): string {
    const key = kind === 'task'
        ? count === 1 ? 'list.countTaskSingular' : 'common.tasks'
        : kind === 'project'
            ? count === 1 ? 'list.countProjectSingular' : 'projects.count'
            : count === 1 ? 'calendar.eventSingular' : 'calendar.eventPlural';
    return tFallback(t, key, count === 1 ? kind : `${kind}s`);
}
