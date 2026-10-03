import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DingTalkSyncError } from '../../../lib/dingtalk-mcp';
import { SettingsDingTalkSection } from './SettingsDingTalkSection';

const loadDingTalkMcpUrl = vi.fn(async () => '');
const saveDingTalkMcpUrl = vi.fn(async () => undefined);
const syncDingTalkTodos = vi.fn();
const showToast = vi.fn();

vi.mock('../../../lib/dingtalk-config', () => ({
    isDingTalkSyncAvailable: () => true,
    loadDingTalkMcpUrl: () => loadDingTalkMcpUrl(),
    saveDingTalkMcpUrl: (...args: unknown[]) => saveDingTalkMcpUrl(...(args as [])),
}));

vi.mock('../../../lib/dingtalk-sync', () => ({
    syncDingTalkTodos: () => syncDingTalkTodos(),
}));

vi.mock('../../../store/ui-store', () => ({
    useUiStore: (selector: (state: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}));

const t = {
    dingtalkSync: 'DingTalk todo sync',
    dingtalkSyncDesc: 'Pull your DingTalk todos into the Inbox.',
    dingtalkMcpUrl: 'MCP address',
    dingtalkMcpUrlHint: 'Paste the DingTalk MCP gateway address.',
    dingtalkMcpUrlStored: 'An address is saved.',
    dingtalkSave: 'Save address',
    dingtalkSyncNow: 'Sync now',
    dingtalkSyncing: 'Syncing...',
    dingtalkLastSynced: 'Last synced',
    dingtalkNeverSynced: 'Not synced yet',
    dingtalkImportedCount: '{{count}} added',
    dingtalkCompletedCount: '{{count}} completed',
    dingtalkAuthFailed: 'DingTalk rejected this address.',
    dingtalkSaveFailed: 'Failed to save.',
    dingtalkSyncFailed: 'Sync failed.',
};

const baseProps: Parameters<typeof SettingsDingTalkSection>[0] = {
    t,
    isTauri: true,
    showSaved: vi.fn(),
};

const expand = (getByRole: (role: string, options: { name: RegExp }) => HTMLElement) => {
    fireEvent.click(getByRole('button', { name: /DingTalk todo sync/i }));
};

describe('SettingsDingTalkSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadDingTalkMcpUrl.mockResolvedValue('');
        localStorage.clear();
    });

    it('starts collapsed and expands on demand', () => {
        const { getByRole, queryByText, getByText } = render(<SettingsDingTalkSection {...baseProps} />);

        const toggle = getByRole('button', { name: /DingTalk todo sync/i });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(queryByText('MCP address')).not.toBeInTheDocument();

        expand(getByRole);
        expect(getByText('MCP address')).toBeInTheDocument();
    });

    it('tags the row so settings search can find it', () => {
        const { container } = render(<SettingsDingTalkSection {...baseProps} />);
        expect(container.querySelector('[data-settings-key="dingtalkSync"]')).not.toBeNull();
    });

    it('keeps sync disabled until an address is stored', async () => {
        const { getByRole } = render(<SettingsDingTalkSection {...baseProps} />);
        expand(getByRole);

        expect(getByRole('button', { name: 'Sync now' })).toBeDisabled();

        await waitFor(() => expect(loadDingTalkMcpUrl).toHaveBeenCalled());
    });

    it('saves the pasted address and reports the stored state', async () => {
        const { getByRole, getByLabelText, getByText } = render(<SettingsDingTalkSection {...baseProps} />);
        expand(getByRole);

        fireEvent.change(getByLabelText('MCP address'), { target: { value: 'https://mcp-gw.example/x?key=k' } });
        fireEvent.click(getByRole('button', { name: 'Save address' }));

        await waitFor(() => expect(saveDingTalkMcpUrl).toHaveBeenCalledWith('https://mcp-gw.example/x?key=k'));
        await waitFor(() => expect(getByText('An address is saved.')).toBeInTheDocument());
        // The field is cleared after saving so the credential is not left on screen.
        expect(getByLabelText('MCP address')).toHaveValue('');
    });

    it('reports an expired address distinctly from a generic failure', async () => {
        loadDingTalkMcpUrl.mockResolvedValue('https://mcp-gw.example/x?key=k');
        // A real DingTalkSyncError, so this exercises the actual classification rather than a
        // stand-in that happens to carry a `kind` field.
        syncDingTalkTodos.mockRejectedValue(new DingTalkSyncError('auth', 'expired'));

        const { getByRole, findByText } = render(<SettingsDingTalkSection {...baseProps} />);
        expand(getByRole);

        await waitFor(() => expect(getByRole('button', { name: 'Sync now' })).toBeEnabled());
        fireEvent.click(getByRole('button', { name: 'Sync now' }));

        expect(await findByText('DingTalk rejected this address.')).toBeInTheDocument();
    });

    it('shows the counts after a successful sync', async () => {
        loadDingTalkMcpUrl.mockResolvedValue('https://mcp-gw.example/x?key=k');
        syncDingTalkTodos.mockResolvedValue({
            importedTaskCount: 3,
            completedExistingCount: 2,
            warnings: [],
        });

        const { getByRole, findByText } = render(<SettingsDingTalkSection {...baseProps} />);
        expand(getByRole);

        await waitFor(() => expect(getByRole('button', { name: 'Sync now' })).toBeEnabled());
        fireEvent.click(getByRole('button', { name: 'Sync now' }));

        expect(await findByText(/3 added/)).toBeInTheDocument();
        expect(await findByText(/2 completed/)).toBeInTheDocument();
    });
});
