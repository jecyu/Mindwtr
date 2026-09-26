// Orchestrates a DingTalk sync: read the credential, pull todos, then write them through the
// shared data-transfer transaction so the import gets the same flush/staleness/snapshot/refresh
// guarantees as every other bulk write.
import {
    applyDingTalkImport,
    parseDingTalkTodos,
    runDataTransferTransaction,
} from '@mindwtr/core';

import { desktopBoundaries } from './data-transfer';
import { loadDingTalkMcpUrl } from './dingtalk-config';
import { DingTalkSyncError, fetchDingTalkTodos } from './dingtalk-mcp';
import { getTauriHttpFetch } from './tauri-http';

export type DingTalkSyncResult = {
    importedTaskCount: number;
    completedExistingCount: number;
    /** Includes applyImport's own "N tasks were skipped because it was already imported" note. */
    warnings: string[];
};

export const syncDingTalkTodos = async (
    options: { now?: Date; signal?: AbortSignal } = {},
): Promise<DingTalkSyncResult> => {
    const url = await loadDingTalkMcpUrl();
    if (!url) {
        throw new DingTalkSyncError('config', 'No DingTalk MCP address is configured.');
    }

    // Prefer the native fetch: the webview's own fetch is subject to CORS and the gateway sends
    // no CORS headers. It also carries the user's proxy settings.
    const fetchImpl = (await getTauriHttpFetch()) ?? fetch;
    const todos = await fetchDingTalkTodos({ url, fetchImpl, signal: options.signal });
    const parsed = parseDingTalkTodos(todos);

    const { result } = await runDataTransferTransaction({
        ...desktopBoundaries,
        operation: 'syncDingTalk',
        apply: (currentData) => {
            const applied = applyDingTalkImport(currentData, parsed, { now: options.now });
            return { data: applied.data, result: applied };
        },
    });

    return {
        importedTaskCount: result.importedTaskCount,
        completedExistingCount: result.completedExistingCount,
        warnings: result.warnings,
    };
};
