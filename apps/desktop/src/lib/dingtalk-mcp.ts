// Minimal MCP client for the DingTalk todo gateway.
//
// Hand-written rather than using @modelcontextprotocol/sdk: the SDK's client entry pulls in
// ajv at module scope (dist/esm/client/index.js) and its package `exports` declares no
// `browser` condition, so importing it would drag a server-oriented validator into the Vite
// bundle. The gateway's actual surface is small enough that this file replaces it.
//
// Contract verified against the live gateway (2026-09-24):
//   - POST JSON-RPC 2.0 to the configured URL; the credential rides in the query string.
//   - `Accept: application/json, text/event-stream` is REQUIRED — omitting it yields HTTP 406.
//   - The gateway is stateless: no Mcp-Session-Id, and `initialize` is not needed before
//     `tools/call`.
//   - Success is HTTP 200 with `result.content[0].text` holding a STRINGIFIED JSON payload.
//   - Auth failure is ALSO HTTP 200, carrying a JSON-RPC `error` whose message contains
//     `[UNAUTHORIZED] Token验证失败`. Status codes alone cannot detect it.
import type { DingTalkTodo } from '@mindwtr/core';

const DINGTALK_TOOL_GET_USER_TODOS = 'get_user_todos';
const DINGTALK_ROLE_TYPES = ['executor', 'creator'] as const;
// The gateway's hard maximum is 20. Anything larger is NOT rejected — it answers with
// `{"result":{"todoCards":null}}` and `isError:false`, so a bigger page size would silently
// sync nothing at all. Verified against the live gateway on 2026-09-24 (21..100 all null).
const DINGTALK_PAGE_SIZE = 20;
// The account had 40+ todos across both buckets with more pages pending; this only guards
// against a gateway that never clears `hasMore`.
const DINGTALK_MAX_PAGES_PER_QUERY = 40;
// The gateway intermittently answers a valid request with an empty result object (observed once
// in a 19-call burst, and not reproducible against the same page in isolation). One hiccup must
// not discard a sync that has already paged through hundreds of todos.
const DINGTALK_MAX_ATTEMPTS = 3;
const DINGTALK_RETRY_DELAY_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

export type DingTalkSyncErrorKind = 'auth' | 'config' | 'network' | 'other';

export class DingTalkSyncError extends Error {
    readonly kind: DingTalkSyncErrorKind;

    constructor(kind: DingTalkSyncErrorKind, message: string) {
        super(message);
        this.name = 'DingTalkSyncError';
        this.kind = kind;
    }
}

export type DingTalkSyncErrorInfo = { kind: DingTalkSyncErrorKind; message: string };

/** Raw todo card shape as the gateway returns it inside the tool result payload. */
type RawTodoCard = {
    taskId?: string;
    subject?: string;
    finalStatusStage?: number;
    dueTime?: number | null;
    createdTime?: number | null;
    priority?: number;
};

type RawToolPayload = {
    result?: {
        todoCards?: RawTodoCard[];
        hasMore?: boolean;
    };
};

type JsonRpcEnvelope = {
    result?: { content?: Array<{ type?: string; text?: string }> };
    error?: { code?: number; message?: string };
};

/** DingTalk reports a completed todo as stage 2; stage 0 is open. */
const DINGTALK_DONE_STAGE = 2;

const AUTH_MARKERS = ['unauthorized', 'token验证失败', 'token', '鉴权'];

const looksLikeAuthFailure = (message: string): boolean => {
    const normalized = message.toLowerCase();
    return AUTH_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
};

export const toDingTalkSyncError = (error: unknown): DingTalkSyncErrorInfo => {
    if (error instanceof DingTalkSyncError) {
        return { kind: error.kind, message: error.message };
    }
    if (error instanceof Error) {
        const isAbort = error.name === 'AbortError';
        return {
            kind: isAbort ? 'other' : 'network',
            message: isAbort ? 'Sync was cancelled.' : `Could not reach DingTalk: ${error.message}`,
        };
    }
    return { kind: 'other', message: String(error) };
};

const normalizeCard = (card: RawTodoCard): DingTalkTodo | null => {
    const taskId = typeof card.taskId === 'string' ? card.taskId.trim() : '';
    if (!taskId) return null;
    return {
        taskId,
        subject: typeof card.subject === 'string' ? card.subject : '',
        done: card.finalStatusStage === DINGTALK_DONE_STAGE,
        // `get_user_todos` does not expose a completion timestamp, so the reconcile pass falls
        // back to the sync clock. `get_todo_detail` has `finishTime`, but calling it per todo
        // would add an N+1 round trip to every sync.
        doneTime: null,
        dueTime: card.dueTime ?? null,
        createdAt: card.createdTime ?? null,
        priority: card.priority,
    };
};

const parseToolPayload = (envelope: JsonRpcEnvelope): RawToolPayload => {
    const text = envelope.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
        throw new DingTalkSyncError('other', 'DingTalk returned an unexpected tool result.');
    }
    try {
        return JSON.parse(text) as RawToolPayload;
    } catch {
        throw new DingTalkSyncError('other', 'DingTalk returned a malformed tool result.');
    }
};

const postJsonRpc = async (opts: {
    url: string;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    body: unknown;
}): Promise<JsonRpcEnvelope> => {
    const { url, fetchImpl, signal, body } = opts;

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                // Required by the gateway; without it the request fails with HTTP 406.
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        throw new DingTalkSyncError('network', `Could not reach DingTalk: ${(error as Error).message}`);
    }

    if (response.status === 401 || response.status === 403) {
        throw new DingTalkSyncError('auth', 'DingTalk rejected the MCP address. It may have expired.');
    }
    if (!response.ok) {
        throw new DingTalkSyncError('other', `DingTalk responded with HTTP ${response.status}.`);
    }

    let envelope: JsonRpcEnvelope;
    try {
        envelope = await response.json() as JsonRpcEnvelope;
    } catch {
        throw new DingTalkSyncError('other', 'DingTalk returned a response that was not JSON.');
    }

    if (envelope.error) {
        const message = envelope.error.message ?? 'Unknown JSON-RPC error.';
        // Auth failures arrive as HTTP 200 with an error body, so the message is the only signal.
        throw looksLikeAuthFailure(message)
            ? new DingTalkSyncError('auth', `DingTalk rejected the MCP address. It may have expired. (${message})`)
            : new DingTalkSyncError('other', message);
    }

    return envelope;
};

/**
 * Fetches every todo for the signed-in account.
 *
 * Queries both roles and both completion buckets, because the gateway's `todoStatus` defaults to
 * "unfinished only" — relying on the default would silently never see completed todos and the
 * completion sync would do nothing.
 */
export const fetchDingTalkTodos = async (opts: {
    url: string;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
}): Promise<DingTalkTodo[]> => {
    const { url, fetchImpl, signal } = opts;
    const collected = new Map<string, DingTalkTodo>();
    let requestId = 1;

    for (const roleType of DINGTALK_ROLE_TYPES) {
        for (const todoStatus of ['false', 'true'] as const) {
            let page = 1;
            for (;;) {
                let cards: RawTodoCard[] = [];
                let hasMore = false;
                let attempt = 0;

                for (;;) {
                    attempt += 1;
                    try {
                        const envelope = await postJsonRpc({
                            url,
                            fetchImpl,
                            signal,
                            body: {
                                jsonrpc: '2.0',
                                id: requestId++,
                                method: 'tools/call',
                                params: {
                                    name: DINGTALK_TOOL_GET_USER_TODOS,
                                    arguments: {
                                        roleTypes: [roleType],
                                        todoStatus,
                                        pageNum: String(page),
                                        pageSize: String(DINGTALK_PAGE_SIZE),
                                    },
                                },
                            },
                        });

                        const payload = parseToolPayload(envelope);
                        const rawCards = payload.result?.todoCards;
                        // Fail loudly rather than treating an unreadable page as "no todos".
                        // The gateway reports an over-large page size this exact way, and silently
                        // syncing nothing is the one outcome a user cannot notice.
                        if (!Array.isArray(rawCards)) {
                            throw new DingTalkSyncError(
                                'other',
                                'DingTalk returned an unreadable todo list. The sync stopped rather than importing nothing.',
                            );
                        }
                        cards = rawCards;
                        hasMore = Boolean(payload.result?.hasMore);
                        break;
                    } catch (error) {
                        const kind = error instanceof DingTalkSyncError ? error.kind : 'network';
                        // Never retry an expired credential; it cannot succeed on its own.
                        if (kind === 'auth' || attempt >= DINGTALK_MAX_ATTEMPTS) throw error;
                        await delay(DINGTALK_RETRY_DELAY_MS * attempt);
                    }
                }

                for (const card of cards) {
                    const normalized = normalizeCard(card);
                    // A todo the user both created and executes comes back under both roles.
                    if (normalized) collected.set(normalized.taskId, normalized);
                }

                if (!hasMore) break;
                page += 1;
                if (page > DINGTALK_MAX_PAGES_PER_QUERY) {
                    throw new DingTalkSyncError('other', 'DingTalk kept reporting more pages; sync stopped to avoid a loop.');
                }
            }
        }
    }

    return [...collected.values()];
};
