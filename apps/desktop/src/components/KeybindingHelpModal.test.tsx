import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { KeybindingHelpModal } from './KeybindingHelpModal';
import { GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT } from '../lib/global-quick-add-shortcut';

describe('KeybindingHelpModal', () => {
    const renderModal = (style: 'vim' | 'emacs' | 'standard') => {
        return render(
            <KeybindingHelpModal
                style={style}
                onClose={vi.fn()}
                currentView="inbox"
                quickAddShortcut={GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT}
                t={(key) => key}
            />
        );
    };

    it('shows complete vim keybinding help entries', () => {
        const { getByText, queryByText } = renderModal('vim');
        const primary = /mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl';

        expect(getByText(`${primary}+,`)).toBeInTheDocument();
        expect(getByText(primary === 'Cmd' ? 'Cmd+Option+S' : 'Ctrl+Alt+S')).toBeInTheDocument();
        expect(getByText(`${primary}+B / ${primary}+\\`)).toBeInTheDocument();
        expect(getByText(`${primary}+Shift+D`)).toBeInTheDocument();
        expect(getByText(`${primary}+Shift+C`)).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(getByText('a')).toBeInTheDocument();
        expect(getByText('Global quick add')).toBeInTheDocument();
        expect(getByText('In-app quick add')).toBeInTheDocument();
        expect(getByText('gi')).toBeInTheDocument();
        expect(getByText('1-9 / Shift+A 1-9')).toBeInTheDocument();
        expect(getByText('0 / Shift+A 0')).toBeInTheDocument();
        expect(getByText('dd')).toBeInTheDocument();
        expect(getByText('gT')).toBeInTheDocument();
        expect(queryByText('Alt-i')).not.toBeInTheDocument();
    });

    it('shows complete emacs keybinding help entries', () => {
        const { getByText, queryByText } = renderModal('emacs');
        const primary = /mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl';

        expect(getByText(`${primary}+,`)).toBeInTheDocument();
        expect(getByText(primary === 'Cmd' ? 'Cmd+Option+S' : 'Ctrl+Alt+S')).toBeInTheDocument();
        expect(getByText('Ctrl+H / Ctrl+?')).toBeInTheDocument();
        expect(getByText('a')).toBeInTheDocument();
        expect(getByText('Global quick add')).toBeInTheDocument();
        expect(getByText('In-app quick add')).toBeInTheDocument();
        expect(getByText('Alt+I')).toBeInTheDocument();
        expect(getByText('Alt+Shift+A')).toBeInTheDocument();
        expect(getByText('Alt+Shift+T')).toBeInTheDocument();
        expect(getByText('Ctrl+N / Ctrl+P / ↑ / ↓')).toBeInTheDocument();
        expect(getByText('F11')).toBeInTheDocument();
        expect(queryByText('gi')).not.toBeInTheDocument();
    });

    it('shows Standard focus and rename shortcuts', () => {
        const { getByText } = renderModal('standard');

        expect(getByText('S').parentElement).toHaveTextContent("Add to today's focus");
        expect(getByText('F2').parentElement).toHaveTextContent('Rename task');
    });
});
