import { useCallback, useEffect, useState } from 'react';
import { safeFormatDate } from '@mindwtr/core';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { isDingTalkSyncAvailable, loadDingTalkMcpUrl, saveDingTalkMcpUrl } from '../../../lib/dingtalk-config';
import { toDingTalkSyncError } from '../../../lib/dingtalk-mcp';
import { syncDingTalkTodos } from '../../../lib/dingtalk-sync';
import { useUiStore } from '../../../store/ui-store';
import { SettingField } from './SettingRow';

type Labels = {
    dingtalkSync: string;
    dingtalkSyncDesc: string;
    dingtalkMcpUrl: string;
    dingtalkMcpUrlHint: string;
    dingtalkMcpUrlStored: string;
    dingtalkSave: string;
    dingtalkSyncNow: string;
    dingtalkSyncing: string;
    dingtalkLastSynced: string;
    dingtalkNeverSynced: string;
    dingtalkImportedCount: string;
    dingtalkCompletedCount: string;
    dingtalkAuthFailed: string;
    dingtalkSaveFailed: string;
    dingtalkSyncFailed: string;
};

type SettingsDingTalkSectionProps = {
    t: Labels;
    isTauri: boolean;
    showSaved: () => void;
};

type LastSyncSummary = {
    at: string;
    imported: number;
    completed: number;
};

// Device-local UI memory, not app data: it records what this machine last did, and must not
// ride along in the synced document.
const LAST_SYNC_STORAGE_KEY = 'mindwtr-dingtalk-last-sync';

const readLastSync = (): LastSyncSummary | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<LastSyncSummary>;
        if (typeof parsed?.at !== 'string') return null;
        return { at: parsed.at, imported: Number(parsed.imported) || 0, completed: Number(parsed.completed) || 0 };
    } catch {
        return null;
    }
};

const writeLastSync = (summary: LastSyncSummary): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(LAST_SYNC_STORAGE_KEY, JSON.stringify(summary));
    } catch {
        // A full quota must not fail the sync that already succeeded.
    }
};

export function SettingsDingTalkSection({ t, isTauri, showSaved }: SettingsDingTalkSectionProps) {
    const showToast = useUiStore((state) => state.showToast);
    const [open, setOpen] = useState(false);
    const [url, setUrl] = useState('');
    const [hasUrl, setHasUrl] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastSync, setLastSync] = useState<LastSyncSummary | null>(() => readLastSync());

    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;
        (async () => {
            const stored = await loadDingTalkMcpUrl();
            if (cancelled) return;
            setHasUrl(Boolean(stored));
        })();
        return () => {
            cancelled = true;
        };
    }, [isTauri]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        setError(null);
        try {
            await saveDingTalkMcpUrl(url);
            setHasUrl(Boolean(url.trim()));
            setUrl('');
            showSaved();
        } catch {
            showToast(t.dingtalkSaveFailed, 'error', 6000);
        } finally {
            setIsSaving(false);
        }
    }, [showSaved, showToast, t.dingtalkSaveFailed, url]);

    const handleSync = useCallback(async () => {
        setIsSyncing(true);
        setError(null);
        try {
            const result = await syncDingTalkTodos();
            const summary: LastSyncSummary = {
                at: new Date().toISOString(),
                imported: result.importedTaskCount,
                completed: result.completedExistingCount,
            };
            setLastSync(summary);
            writeLastSync(summary);
            // Built outside the showToast call: the toast-i18n guard reads the first argument
            // for prose literals, and an inline template with nested braces reads as hardcoded
            // English.
            const summaryMessage = [
                t.dingtalkImportedCount.replace('{{count}}', String(summary.imported)),
                t.dingtalkCompletedCount.replace('{{count}}', String(summary.completed)),
            ].join(' · ');
            showToast(summaryMessage, 'success');
        } catch (syncError) {
            const info = toDingTalkSyncError(syncError);
            // The credential expiring is the expected failure here, so say so plainly rather
            // than surfacing a raw gateway message.
            const message = info.kind === 'auth' ? t.dingtalkAuthFailed : (info.message || t.dingtalkSyncFailed);
            setError(message);
            showToast(message, 'error', 8000);
        } finally {
            setIsSyncing(false);
        }
    }, [showToast, t.dingtalkAuthFailed, t.dingtalkCompletedCount, t.dingtalkImportedCount, t.dingtalkSyncFailed]);

    const statusLine = lastSync
        ? safeFormatDate(lastSync.at, 'PPpp', lastSync.at)
        : t.dingtalkNeverSynced;

    return (
        <div className="bg-card border border-border rounded-lg">
            <div className="p-4">
                <button data-settings-key="dingtalkSync" data-settings-section="dingtalkSync"
                    type="button"
                    onClick={() => setOpen((prev) => !prev)}
                    aria-expanded={open}
                    className="w-full text-left flex items-center justify-between gap-4"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.dingtalkSync}</div>
                        <p className="text-xs text-muted-foreground mt-1">{t.dingtalkSyncDesc}</p>
                    </div>
                    {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
            </div>
            {open && (
                <div className="border-t border-border p-4 space-y-4">
                    <SettingField settingsKey="dingtalkMcpUrl" title={t.dingtalkMcpUrl}>
                        <input
                            type="password"
                            value={url}
                            aria-label={t.dingtalkMcpUrl}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder={hasUrl ? '••••••••' : 'https://mcp-gw.dingtalk.com/server/…'}
                            autoComplete="new-password"
                            spellCheck={false}
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <p className="text-xs text-muted-foreground">
                            {hasUrl ? t.dingtalkMcpUrlStored : t.dingtalkMcpUrlHint}
                        </p>
                    </SettingField>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                                {t.dingtalkLastSynced}:{' '}
                                <span className="font-medium text-foreground">{statusLine}</span>
                                {lastSync && (
                                    <>
                                        {' · '}
                                        {t.dingtalkImportedCount.replace('{{count}}', String(lastSync.imported))}
                                        {' · '}
                                        {t.dingtalkCompletedCount.replace('{{count}}', String(lastSync.completed))}
                                    </>
                                )}
                            </p>
                            {error && <p className="text-xs text-warning">{error}</p>}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={handleSync}
                                disabled={isSyncing || !hasUrl || !isTauri}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSyncing ? t.dingtalkSyncing : t.dingtalkSyncNow}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={isSaving || !url.trim() || !isDingTalkSyncAvailable()}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                            >
                                {t.dingtalkSave}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
