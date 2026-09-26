// DingTalk MCP credentials live in the OS keyring, written by the Rust side.
//
// There is deliberately no web/localStorage fallback, unlike the AI key: the sync only works in
// the Tauri build (it needs the native HTTP proxy), so a browser session reports "not
// configured" rather than inventing a weaker place to keep a credential. Same reasoning as the
// Obsidian and email-capture integrations.
import { isSandboxMode } from '@mindwtr/core';

import { logError } from './app-log';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

export const isDingTalkSyncAvailable = (): boolean => isTauriRuntime() && !isSandboxMode();

/** Returns the configured gateway URL, or '' when unset/unavailable. */
export const loadDingTalkMcpUrl = async (): Promise<string> => {
    if (!isDingTalkSyncAvailable()) return '';
    try {
        const value = await invokeNative<string | null>('get_dingtalk_mcp_url');
        return typeof value === 'string' ? value : '';
    } catch (error) {
        void logError(error, { scope: 'dingtalk', step: 'loadUrl' });
        return '';
    }
};

/** An empty string clears the stored URL. Throws so the UI can report a failed save. */
export const saveDingTalkMcpUrl = async (url: string): Promise<void> => {
    if (!isDingTalkSyncAvailable()) return;
    await invokeNative('set_dingtalk_mcp_url', { value: url.trim() || null });
};
