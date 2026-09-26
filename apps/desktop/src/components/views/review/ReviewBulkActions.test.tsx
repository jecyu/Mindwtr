import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewBulkActions } from './ReviewBulkActions';

describe('ReviewBulkActions', () => {
    it('offers a due-only mark-reviewed action for selected tasks', () => {
        const onMarkReviewed = vi.fn();
        const props = {
            selectionCount: 2,
            moveToStatus: '' as const,
            onMoveToStatus: vi.fn(),
            onChangeMoveToStatus: vi.fn(),
            onAddTag: vi.fn(),
            onDelete: vi.fn(),
            statusOptions: [] as [],
            t: (key: string) => key === 'review.markReviewed' ? 'Mark reviewed' : key,
        };
        const { rerender } = render(<ReviewBulkActions {...props} onMarkReviewed={onMarkReviewed} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
        expect(onMarkReviewed).toHaveBeenCalledOnce();
        rerender(<ReviewBulkActions {...props} onMarkReviewed={onMarkReviewed} markReviewedBusy />);
        expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
        rerender(<ReviewBulkActions {...props} />);
        expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    });
});
