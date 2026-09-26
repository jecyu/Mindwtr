import {
    DEFAULT_GLOBAL_SEARCH_FILTERS,
    STATUS_COLORS_BY_THEME,
    SqliteAdapter,
    TASK_PRIORITY_COLORS,
    createNativeHostContract,
    legacyImportMismatch,
    logInfo,
    logWarn,
    planLegacyJsonImport,
    setStorageAdapter,
    splitSqlStatements,
    sqliteHasAnyData,
    themeDescriptor,
    type FocusTaskSectionKey,
    type SqliteClient,
    useTaskStore,
} from '@mindwtr/core';

type NativeBridge = {
    sqlRun(sql: string, params: string): string | null;
    sqlAll(sql: string, params: string): string;
    sqlExec(sql: string): string | null;
    nowMs(): number;
    randomBytes(length: number): string;
    log(line: string): void;
    rnStateCommit(change: string): string | null;
};

declare const globalThis: Record<string, unknown> & { MindwtrHost?: unknown };
const native = (): NativeBridge => {
    const bridge = globalThis.__mindwtrNative as NativeBridge | undefined;
    if (!bridge) throw new Error('Native bridge unavailable');
    return bridge;
};

// Kotlin returns a storage exception as a marked string (see CoreHost.guarded):
// a Java exception thrown across the QuickJS JNI boundary aborts the process.
const NATIVE_ERROR = '!MindwtrNativeError:';
const checked = <T,>(value: T): T => {
    if (typeof value === 'string' && value.startsWith(NATIVE_ERROR)) throw new Error(value.slice(NATIVE_ERROR.length));
    return value;
};

const sqlite: SqliteClient = {
    run: async (sql, params) => { checked(native().sqlRun(sql, JSON.stringify(params ?? []))); },
    all: async <T,>(sql: string, params?: unknown[]): Promise<T[]> =>
        JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[],
    get: async <T,>(sql: string, params?: unknown[]): Promise<T | undefined> =>
        (JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[])[0],
    exec: async (sql) => {
        for (const statement of splitSqlStatements(sql)) checked(native().sqlExec(statement));
    },
};

type LoadedData = Awaited<ReturnType<SqliteAdapter['getData']>>;
class ValidatedSqliteAdapter extends SqliteAdapter {
    latestData: LoadedData | null = null;

    override async getData(): Promise<LoadedData> {
        const data = await super.getData();
        for (const table of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
            const rows = await sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
            if (data[table].length !== rows?.n) throw new Error(`Incomplete ${table} load`);
        }
        const settingsCount = await sqlite.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings WHERE id = 1');
        const settings = await sqlite.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
        if (![0, 1].includes(settingsCount?.n ?? -1) || (settingsCount?.n === 1) !== Boolean(settings)) {
            throw new Error('Incomplete settings load');
        }
        if (settings) {
            const parsed = JSON.parse(settings.data) as Record<string, unknown>;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings load');
            for (const [key, value] of Object.entries(parsed)) {
                if (key !== 'savedFilters' && JSON.stringify(data.settings[key as keyof typeof data.settings]) !== JSON.stringify(value)) {
                    throw new Error('Incomplete settings load');
                }
            }
        }
        const savedFilters = await sqlite.get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_filters');
        if (!Number.isSafeInteger(savedFilters?.n) || savedFilters!.n < 0
            || (savedFilters!.n > 0 && data.settings.savedFilters?.length !== savedFilters!.n)) {
            throw new Error('Incomplete saved filters load');
        }
        this.latestData = data;
        return data;
    }
}

type Pending = { done: boolean; value?: unknown; error?: string };
const pending = new Map<number, Pending>();
let nextId = 1;
const submit = (work: () => Promise<unknown>): string => {
    const id = nextId++;
    const slot: Pending = { done: false };
    pending.set(id, slot);
    void work().then(
        (value) => { slot.value = value; },
        (error) => { slot.error = error instanceof Error ? error.message : String(error); },
    ).finally(() => { slot.done = true; });
    return String(id);
};

const contract = createNativeHostContract();
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if ('error' in result) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
type Command = 'create' | 'complete' | 'update' | 'saveTaskDraft' | 'taskFocus' | 'projectFocus' | 'createProject' | 'areaFilter'
    | 'saveSearch' | 'inboxCommit' | 'inboxSkip' | 'quickCapture' | 'quickCaptureLines' | 'quickCapturePicker';
const taskResult = <T>(operation: Command, result: Parameters<typeof unwrap<T>>[0]): T => {
    const meta = {
        scope: 'native-android',
        category: 'storage' as const,
        extra: { releaseCheck: 'v1.3.3/native-android-dev-task-command', operation, outcome: result.ok ? 'saved' : 'failed' },
    };
    try {
        if (result.ok) logInfo('Native Android task command', meta);
        else logWarn('Native Android task command', meta);
    } catch { /* a diagnostic sink must not change a durable acknowledgment */ }
    return unwrap(result);
};

type LegacyState = { jsonAhead: boolean; reconciled: boolean; backupVersion: string | null; backupPresent: boolean };

/**
 * The React Native app's AsyncStorage backup, imported as RN's next launch would
 * (core's planLegacyJsonImport). Runs after the validated load. RN's own state
 * (the json-ahead marker, the reconcile flag) changes only after the validated
 * re-read holds every imported row and the settings exactly.
 *
 * If that RN state change fails, the boot fails closed: no activation, so no
 * native edit can exist while the marker is still set. Core's merge can let a
 * tombstone beat a newer live row, so re-importing a stale backup over native
 * edits could discard them. The next boot plans again, finds the import already
 * saved, writes nothing to SQLite, and retries only the RN state change.
 */
const importLegacyJson = async (adapter: ValidatedSqliteAdapter, state: LegacyState, backup: string): Promise<void> => {
    const loaded = adapter.latestData;
    if (!loaded) throw new Error('Native storage load was not validated');
    const plan = planLegacyJsonImport({
        jsonAhead: state.jsonAhead,
        reconciled: state.reconciled,
        backupVersion: state.backupVersion,
        backupJson: state.backupPresent ? backup : null,
    }, loaded, await sqliteHasAnyData(sqlite));
    if (plan.merged && legacyImportMismatch(plan.merged, loaded)) {
        await adapter.saveData(plan.merged);
        const mismatch = legacyImportMismatch(plan.merged, await adapter.getData());
        if (mismatch) throw new Error(`Legacy import not confirmed: ${mismatch}`);
    }
    let rnState = 'unchanged';
    let rnFailure = '';
    if (plan.clearJsonAhead || plan.setReconciled) {
        try {
            checked(native().rnStateCommit(JSON.stringify({ clearJsonAhead: plan.clearJsonAhead, setReconciled: plan.setReconciled })));
            rnState = 'updated';
        } catch (error) {
            rnState = 'failed';
            rnFailure = error instanceof Error ? error.message : String(error);
        }
    }
    if (plan.outcome !== 'none') logLegacyImport(plan, rnState);
    if (rnState === 'failed') throw new Error(`Cannot update the previous app version's saved state: ${rnFailure}`);
};

const logLegacyImport = (plan: ReturnType<typeof planLegacyJsonImport>, rnState: string): void => {
    const extra: Record<string, string> = {
        releaseCheck: 'v1.3.3/native-android-legacy-json-import', outcome: plan.outcome, path: plan.path ?? '', rnState,
    };
    if (plan.reason) extra.reason = plan.reason;
    for (const [name, count] of Object.entries(plan.counts ?? {})) extra[name] = String(count);
    const meta = { scope: 'native-android', category: 'storage' as const, extra };
    try {
        if (rnState === 'failed') logWarn('Native Android legacy JSON import', meta);
        else logInfo('Native Android legacy JSON import', meta);
    } catch { /* a diagnostic sink must not fail the boot */ }
};

// After a failed save the store holds changes that are not on disk. Reads
// wait for the exact retry, so no screen treats those changes as stored.
const requireSaved = () => {
    const failure = useTaskStore.getState().persistenceFailure;
    if (failure) throw new Error(`SAVE_FAILED: ${failure.message}`);
};

globalThis.MindwtrHost = {
    poll(idText: string): string | null {
        const id = Number(idText);
        const slot = pending.get(id);
        if (!slot?.done) return null;
        pending.delete(id);
        return JSON.stringify(slot.error === undefined
            ? { ok: true, value: slot.value }
            : { ok: false, error: slot.error });
    },
    /** `legacyState` is "" for the dev database; else LegacyRnStoreGuard's reading of RN's AsyncStorage. */
    boot(legacyState: string, legacyBackup: string): string {
        return submit(async () => {
            const adapter = new ValidatedSqliteAdapter(sqlite, { rejectConcurrentWrites: true });
            // Core's schema setup may write. Kotlin created and validated the
            // app-private pre-write SQLite snapshot before this method runs.
            setStorageAdapter(adapter);
            await adapter.getData();
            if (legacyState) await importLegacyJson(adapter, JSON.parse(legacyState) as LegacyState, legacyBackup);
            unwrap(await contract.activate({ writeSafetyReady: true }));
            const data = adapter.latestData;
            if (!data) throw new Error('Native storage load was not validated');
            const loaded = useTaskStore.getState();
            for (const [table, storeRows] of [
                ['tasks', loaded._allTasks], ['projects', loaded._allProjects],
                ['sections', loaded._allSections], ['areas', loaded._allAreas],
                ['people', loaded._allPeople],
            ] as const) {
                if (storeRows.length !== data[table].length) throw new Error(`Incomplete ${table} activation`);
            }
            return unwrap(contract.getInboxWindow({ offset: 0, limit: 50 }));
        });
    },
    window(offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxWindow({ offset, limit, revision: revision || undefined }));
        });
    },
    focus(limit: number): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocus({ limit }));
        });
    },
    /** Core checks `key` and refuses a stale `revision`; Kotlin then reads Focus again from offset 0. */
    focusWindow(key: string, offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocusSectionWindow({ key: key as FocusTaskSectionKey, offset, limit, revision }));
        });
    },
    editorModel(id: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorModel({ id }));
        });
    },
    /** The checklist and live attachment titles of core's getTask, which the editor shows read-only. */
    editorContent(id: string): string {
        return submit(async () => {
            requireSaved();
            const task = unwrap(contract.getTask({ id }));
            return {
                checklist: (task.checklist ?? []).map(({ title, isCompleted }) => ({ title, isCompleted: isCompleted === true })),
                attachments: (task.attachments ?? []).filter((attachment) => !attachment.deletedAt).map((attachment) => attachment.title),
            };
        });
    },
    /** `json` is `{ id, draft, edit? }`, passed to core's editTaskDraft unchanged: the model for the edited draft. */
    editDraft(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editTaskDraft(JSON.parse(json)));
        });
    },
    /** Core's suggestions for the whole text of a context, tag, or person input. */
    editorSuggestions(id: string, field: string, query: string, limit: number): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorSuggestions({ id, field: field as 'contexts' | 'tags' | 'assignedTo', query, limit }));
        });
    },
    /** Core's setLanguage. "" is no stored language. Labels are not stored data, so no failed save blocks them. */
    language(stored: string, system: string): string {
        return submit(async () => unwrap(await contract.setLanguage({ storedLanguage: stored || null, systemLocale: system || null })));
    },
    /** `keysJson` is a JSON array of core i18n keys. */
    strings(keysJson: string): string {
        return submit(async () => unwrap(contract.getStrings({ keys: JSON.parse(keysJson) as string[] })));
    },
    /**
     * The React Native app's theme, resolved as its theme-context.tsx does: the synced
     * `settings.theme` wins, then RN's device-local `@mindwtr_theme` ([stored], "" for none),
     * then the system. Core classifies the mode and owns the status and priority hues;
     * Kotlin holds only the mobile palettes. Cosmetic, so no failed save blocks it.
     */
    theme(stored: string): string {
        return submit(async () => {
            const synced = useTaskStore.getState().settings?.theme;
            const mode = typeof synced === 'string' && synced ? synced : (stored || 'system');
            const descriptor = themeDescriptor(mode);
            const preset = descriptor?.statusPreset ?? null;
            return {
                mode,
                preset: preset ?? 'default',
                material: mode === 'material3-light' || mode === 'material3-dark',
                scheme: descriptor?.scheme === 'system' ? null : descriptor?.scheme ?? null,
                // Core's status palettes ({ bg, text, border } per status): RN's badges, glyphs, and Done swipe.
                status: {
                    light: STATUS_COLORS_BY_THEME[preset ?? 'light'],
                    dark: STATUS_COLORS_BY_THEME[preset ?? 'dark'],
                },
                priority: TASK_PRIORITY_COLORS,
            };
        });
    },
    projects(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjects());
        });
    },
    /** Core refuses a stale `revision`; Kotlin then reads the project again from offset 0. */
    projectDetail(id: string, offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectDetail({ projectId: id, offset, limit, revision: revision || undefined }));
        });
    },
    /** `json` is `{ id, base, patch }`, passed to core unchanged: the status menu and the Restore and Next swipes. */
    update(json: string): string {
        return submit(async () => taskResult('update', await contract.updateTask(JSON.parse(json))));
    },
    /** `json` is the editor's `{ id, base, patch }` of draft fields, passed to core's saveTaskDraft unchanged. */
    saveDraft(json: string): string {
        return submit(async () => taskResult('saveTaskDraft', await contract.saveTaskDraft(JSON.parse(json))));
    },
    /** The capture popup (RN's quick capture sheet): an empty draft with the starting options. */
    captureOpen(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.openQuickCapture());
        });
    },
    /** `json` is `{ text, options, picker? }`, passed to core unchanged. */
    captureView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getQuickCaptureView(JSON.parse(json)));
        });
    },
    /** `json` is `{ text, options, edit, picker? }`: one control's edit. Nothing is written. */
    captureEdit(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editQuickCapture(JSON.parse(json)));
        });
    },
    /** `json` is `{ text, options, captureId, openAfterSave }`. Reusing captureId retries: the draft is written at most once. */
    captureSubmit(json: string): string {
        return submit(async () => taskResult('quickCapture', await contract.submitQuickCapture(JSON.parse(json))));
    },
    /** The recovery snapshot before a several-lines capture; `{ snapshot: null }` in sandbox mode. */
    captureSnapshot(): string {
        return submit(async () => ({ snapshot: unwrap(await contract.createQuickCaptureSnapshot()) }));
    },
    /** `json` is `{ text, options, captureIds, snapshotFileName }`: one task per line, in one write. */
    captureLines(json: string): string {
        return submit(async () => taskResult('quickCaptureLines', await contract.submitQuickCaptureLines(JSON.parse(json))));
    },
    /** `json` is `{ picker, query, text, options, requestId }`: the project or area picker's search, chosen or created. */
    capturePicker(json: string): string {
        return submit(async () => taskResult('quickCapturePicker', await contract.submitQuickCapturePickerQuery(JSON.parse(json))));
    },
    complete(id: string): string {
        return submit(async () => taskResult('complete', await contract.completeTask({ id })));
    },
    /** A target state, so an exact retry re-sends the same target. A `{ blocked }` reply wrote nothing. */
    taskFocus(id: string, focused: boolean): string {
        return submit(async () => taskResult('taskFocus', await contract.setTaskFocus({ id, focused })));
    },
    projectFocus(id: string, focused: boolean): string {
        return submit(async () => taskResult('projectFocus', await contract.setProjectFocus({ id, focused })));
    },
    /** `areaId` "" is no area. Core dedupes a retry by `requestId` within this process. */
    createProject(title: string, areaId: string, requestId: string): string {
        return submit(async () => taskResult('createProject', await contract.createProject({ title, areaId: areaId || null, requestId })));
    },
    areaFilter(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaFilter());
        });
    },
    /** `json` is one of getAreaFilter's `next` selections, passed to core unchanged. */
    setAreaFilter(json: string): string {
        return submit(async () => taskResult('areaFilter', await contract.setAreaFilter(JSON.parse(json))));
    },
    /**
     * `json` is `{ query, filters, limit }`, passed to core's searchTasks unchanged; the reply echoes the trimmed query.
     * `filters: null` (the screen before any filter change) is core's DEFAULT_GLOBAL_SEARCH_FILTERS.
     */
    search(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = JSON.parse(json);
            return unwrap(await contract.searchTasks({ ...input, filters: input.filters ?? DEFAULT_GLOBAL_SEARCH_FILTERS }));
        });
    },
    /** `json` is `{ query, name, requestId }`. Core saves one search per query, so a retry never adds a second. */
    saveSearch(json: string): string {
        return submit(async () => taskResult('saveSearch', await contract.saveSearch(JSON.parse(json))));
    },
    /** Core's startInboxProcessing in RN's per-device mode ('guided' or 'quick'). */
    inboxStart(mode: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.startInboxProcessing({ mode: mode as 'guided' | 'quick' }));
        });
    },
    /** `json` is `{ sessionId, taskId, step, edit?, mode? }`: one control's edit, passed to core unchanged. */
    inboxStep(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxProcessingStep(JSON.parse(json)));
        });
    },
    /** `json` is `{ sessionId, taskId, step, decision, requestId }`. Core answers a repeated request without writing again. */
    inboxCommit(json: string): string {
        return submit(async () => taskResult('inboxCommit', await contract.commitInboxProcessingStep(JSON.parse(json))));
    },
    /** `json` is `{ sessionId, taskId, requestId }`, the header's Skip. */
    inboxSkip(json: string): string {
        return submit(async () => taskResult('inboxSkip', await contract.skipInboxProcessingTask(JSON.parse(json))));
    },
    /** Closes the session; it writes nothing. Core answers null; Kotlin reads an object. */
    inboxEnd(sessionId: string): string {
        return submit(async () => {
            unwrap(contract.endInboxProcessing({ sessionId }));
            return {};
        });
    },
};
