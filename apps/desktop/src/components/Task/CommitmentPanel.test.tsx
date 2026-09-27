import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { CommitmentPanel } from './CommitmentPanel';

const initialState = useTaskStore.getState();

const renderPanel = (taskId = 't1', dueDate?: string) => render(
    <LanguageProvider>
        <CommitmentPanel taskId={taskId} dueDate={dueDate} />
    </LanguageProvider>,
);

describe('CommitmentPanel', () => {
    beforeEach(() => {
        useTaskStore.setState(initialState, true);
    });

    it('opens unassessed rather than silently scoring the task', () => {
        renderPanel('t1', '2026-09-29T12:00');

        expect(screen.getByText('Not assessed')).toBeInTheDocument();
        expect(screen.getByLabelText('Benchmark')).toBeInTheDocument();
        // Nothing is written until the first edit.
        expect(useTaskStore.getState().settings.commitmentCards?.t1).toBeUndefined();
    });

    it('persists the first edit into settings', () => {
        renderPanel('t1', '2026-09-29T12:00');

        fireEvent.change(screen.getByLabelText('Benchmark'), { target: { value: 'q3-review' } });

        const card = useTaskStore.getState().settings.commitmentCards?.t1;
        expect(card).toBeDefined();
        expect(card?.benchmarkId).toBe('q3-review');
    });

    it('scores against the seeded benchmark library', () => {
        // A due date far enough out that urgency sits at its floor, so the
        // arithmetic does not drift with the wall clock.
        renderPanel('t1', '2030-01-01T12:00');

        // Defaults: goal max(2, 2) = 2, urgency 1, impact 2, delegable 3 -> value 8.
        // The seeded Q3 benchmark is 5 points at x1 -> 8 / 5.
        fireEvent.change(screen.getByLabelText('Benchmark'), { target: { value: 'q3-review' } });

        expect(screen.getByText('1.60')).toBeInTheDocument();
    });

    it('clears an existing assessment', () => {
        renderPanel('t1');
        fireEvent.change(screen.getByLabelText('Benchmark'), { target: { value: 'weekly-report' } });
        expect(useTaskStore.getState().settings.commitmentCards?.t1).toBeDefined();

        fireEvent.click(screen.getByLabelText('Clear assessment'));
        expect(useTaskStore.getState().settings.commitmentCards?.t1).toBeUndefined();
    });

    it('warns when an external deadline has no due date to agree with', () => {
        renderPanel('t1', undefined);

        fireEvent.click(screen.getByText('external-deadline'));

        expect(screen.getByText('An external deadline needs a due date on the task.')).toBeInTheDocument();
    });
});
