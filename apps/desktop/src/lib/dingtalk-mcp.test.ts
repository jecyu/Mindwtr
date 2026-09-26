import { describe, expect, it, vi } from 'vitest';

import {
    DingTalkSyncError,
    fetchDingTalkTodos,
    toDingTalkSyncError,
} from './dingtalk-mcp';

const URL_UNDER_TEST = 'https://mcp-gw.example/server/abc?key=secret';

type FakeResponse = {
    status: number;
    ok: boolean;
    json: () => Promise<unknown>;
};

const jsonResponse = (body: unknown, status = 200): FakeResponse => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
});

/** Wraps a tool payload the way the gateway does: stringified JSON inside content[0].text. */
const toolResponse = (payload: unknown): FakeResponse => jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
});

const card = (overrides: Record<string, unknown> = {}) => ({
    taskId: '57501590769',
    subject: '跟林丛对接下',
    finalStatusStage: 0,
    dueTime: null,
    createdTime: 1_790_149_368_000,
    priority: 20,
    ...overrides,
});

const fetchMockOf = (responses: FakeResponse[]) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return response;
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
};

const parseBody = (init: RequestInit): { method: string; params: { name: string; arguments: Record<string, string> } } => (
    JSON.parse(String(init.body))
);

describe('fetchDingTalkTodos', () => {
    it('sends the Accept header the gateway requires', async () => {
        const { fetchImpl, calls } = fetchMockOf([toolResponse({ result: { todoCards: [], hasMore: false } })]);

        await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers.accept).toContain('application/json');
        expect(headers.accept).toContain('text/event-stream');
        expect(headers['content-type']).toBe('application/json');
    });

    it('requests the gateway maximum page size of 20', async () => {
        const { fetchImpl, calls } = fetchMockOf([toolResponse({ result: { todoCards: [], hasMore: false } })]);

        await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        // Above 20 the gateway answers with todoCards:null and isError:false, so a larger page
        // size would silently sync nothing.
        expect(parseBody(calls[0].init).params.arguments.pageSize).toBe('20');
    });

    // The gateway reports an over-large page size as `todoCards: null` with isError:false.
    // Treating that as "no todos" is the one failure a user would never notice.
    it('throws instead of reporting an empty list when todoCards is null', async () => {
        const { fetchImpl } = fetchMockOf([toolResponse({ result: { todoCards: null } })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'other' });
    });

    it('accepts a genuinely empty page', async () => {
        const { fetchImpl } = fetchMockOf([toolResponse({ result: { todoCards: [], hasMore: false } })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl })).resolves.toEqual([]);
    });

    it('queries both roles and both completion buckets', async () => {
        const { fetchImpl, calls } = fetchMockOf([toolResponse({ result: { todoCards: [], hasMore: false } })]);

        await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(calls).toHaveLength(4);
        const queries = calls.map((call) => {
            const { arguments: args } = parseBody(call.init).params;
            return `${args.roleTypes}:${args.todoStatus}`;
        });
        expect(new Set(queries)).toEqual(new Set([
            'executor:false', 'executor:true', 'creator:false', 'creator:true',
        ]));
    });

    it('paginates until the gateway reports no more pages', async () => {
        const { fetchImpl, calls } = fetchMockOf([
            toolResponse({ result: { todoCards: [card({ taskId: 'a' })], hasMore: true } }),
            toolResponse({ result: { todoCards: [card({ taskId: 'b' })], hasMore: false } }),
        ]);

        const todos = await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(todos.map((todo) => todo.taskId).sort()).toEqual(['a', 'b']);
        // Two pages for the first query, one for each of the remaining three.
        expect(calls).toHaveLength(5);
    });

    it('dedupes a todo that comes back under both roles', async () => {
        const { fetchImpl } = fetchMockOf([
            toolResponse({ result: { todoCards: [card({ taskId: 'same' })], hasMore: false } }),
            toolResponse({ result: { todoCards: [], hasMore: false } }),
            toolResponse({ result: { todoCards: [card({ taskId: 'same' })], hasMore: false } }),
            toolResponse({ result: { todoCards: [], hasMore: false } }),
        ]);

        const todos = await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(todos).toHaveLength(1);
    });

    it('treats finalStatusStage 2 as done and 0 as open', async () => {
        const { fetchImpl } = fetchMockOf([
            toolResponse({ result: { todoCards: [card({ taskId: 'open', finalStatusStage: 0 })], hasMore: false } }),
            toolResponse({ result: { todoCards: [card({ taskId: 'done', finalStatusStage: 2 })], hasMore: false } }),
            toolResponse({ result: { todoCards: [], hasMore: false } }),
            toolResponse({ result: { todoCards: [], hasMore: false } }),
        ]);

        const todos = await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(todos.find((todo) => todo.taskId === 'open')?.done).toBe(false);
        expect(todos.find((todo) => todo.taskId === 'done')?.done).toBe(true);
    });

    it('skips cards without a taskId', async () => {
        const { fetchImpl } = fetchMockOf([
            toolResponse({ result: { todoCards: [card({ taskId: undefined })], hasMore: false } }),
        ]);

        const todos = await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(todos).toEqual([]);
    });

    it('stops instead of looping forever when the gateway never clears hasMore', async () => {
        const { fetchImpl } = fetchMockOf([
            toolResponse({ result: { todoCards: [], hasMore: true } }),
        ]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toThrow(/more pages/i);
    });

});

describe('fetchDingTalkTodos error classification', () => {
    // The gateway answers auth failures with HTTP 200 and a JSON-RPC error body, so a status
    // check alone would treat an expired credential as success.
    it('detects an auth failure delivered as HTTP 200 with a JSON-RPC error', async () => {
        const { fetchImpl } = fetchMockOf([jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: '获取工具列表失败: 服务返回失败: [UNAUTHORIZED] Token验证失败' },
        })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'auth' });
    });

    it('detects an auth failure delivered as HTTP 401', async () => {
        const { fetchImpl } = fetchMockOf([jsonResponse({}, 401)]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'auth' });
    });

    it('classifies a transport failure as network', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'network' });
    });

    it('classifies a malformed tool result as other', async () => {
        const { fetchImpl } = fetchMockOf([jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'not json' }] },
        })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'other' });
    });

    it('retries a transient malformed response instead of discarding the sync', async () => {
        const { fetchImpl, calls } = fetchMockOf([
            // Observed in practice: the gateway occasionally answers a valid request with an
            // empty result object.
            jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }),
            toolResponse({ result: { todoCards: [card({ taskId: 'recovered' })], hasMore: false } }),
        ]);

        const todos = await fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl });

        expect(todos.map((todo) => todo.taskId)).toEqual(['recovered']);
        expect(calls.length).toBeGreaterThan(1);
    });

    it('gives up after repeated malformed responses', async () => {
        const { fetchImpl } = fetchMockOf([jsonResponse({ jsonrpc: '2.0', id: 1, result: {} })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'other' });
    });

    it('does not retry an auth failure', async () => {
        const { fetchImpl, calls } = fetchMockOf([jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: '[UNAUTHORIZED] Token验证失败' },
        })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'auth' });
        // An expired credential cannot succeed by being asked again.
        expect(calls).toHaveLength(1);
    });

    it('surfaces a non-auth JSON-RPC error without mislabelling it', async () => {
        const { fetchImpl } = fetchMockOf([jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'Method not found' },
        })]);

        await expect(fetchDingTalkTodos({ url: URL_UNDER_TEST, fetchImpl }))
            .rejects.toMatchObject({ kind: 'other' });
    });
});

describe('toDingTalkSyncError', () => {
    it('preserves a classified sync error', () => {
        expect(toDingTalkSyncError(new DingTalkSyncError('auth', 'expired')))
            .toEqual({ kind: 'auth', message: 'expired' });
    });

    it('maps an unknown throwable to other', () => {
        expect(toDingTalkSyncError('boom').kind).toBe('other');
    });
});
