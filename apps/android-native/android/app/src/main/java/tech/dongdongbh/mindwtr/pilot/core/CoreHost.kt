package tech.dongdongbh.mindwtr.pilot.core

import android.util.Log
import com.whl.quickjs.android.QuickJSLoader
import com.whl.quickjs.wrapper.JSCallFunction
import com.whl.quickjs.wrapper.JSFunction
import com.whl.quickjs.wrapper.JSObject
import com.whl.quickjs.wrapper.QuickJSContext
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.BuildConfig
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * QuickJS and SQLite share one worker thread; Compose never enters either runtime.
 * [rnDataDir] is set only when [databaseFile] is the React Native app's database:
 * then the JS host may apply RN's AsyncStorage change after it imported RN's backup.
 */
class CoreHost(private val databaseFile: File, private val rnDataDir: File? = null) {
    companion object {
        const val TAG = "MindwtrNativeDev"
        /** Must match NATIVE_ERROR in bundle/host-entry.ts. */
        private const val NATIVE_ERROR = "!MindwtrNativeError:"

        /**
         * A Kotlin exception must not cross the QuickJS JNI boundary: the
         * wrapper keeps calling JNI with it pending and the process aborts.
         * Return it as a marked string; host-entry.ts throws it inside JS.
         */
        private fun guarded(work: (Array<out Any?>) -> Any?) = JSCallFunction { args ->
            try { work(args) } catch (error: Throwable) { NATIVE_ERROR + (error.message ?: error.javaClass.simpleName) }
        }
        init { QuickJSLoader.init() }
    }

    private val lifecycleLock = Any()
    private var shutdown: Future<*>? = null
    private val random = SecureRandom()
    private val startedAt = System.nanoTime()
    private var context: QuickJSContext? = null
    private var sqlite: SqliteBridge? = null
    private val functions = HashMap<String, JSFunction>()
    private var hostObject: JSObject? = null
    @Volatile private var engineThread: Thread? = null
    private val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "mindwtr-core").also { engineThread = it }
    }

    private fun <T> onEngine(work: () -> T): T {
        if (Thread.currentThread() === engineThread) return work()
        val task = synchronized(lifecycleLock) {
            check(shutdown == null) { "Core host is closed" }
            executor.submit(Callable { work() })
        }
        // Rethrow the engine's own exception: callers match "SAVE_FAILED" on its message.
        return try { task.get() } catch (failure: ExecutionException) { throw failure.cause ?: failure }
    }

    private fun call(method: String, vararg args: Any?): Any? = onEngine {
        val engine = checkNotNull(context)
        val host = hostObject ?: engine.globalObject.getJSObject("MindwtrHost").also { hostObject = it }
        functions.getOrPut(method) { host.getJSFunction(method) }.call(*args)
    }

    /** [legacyState] and [legacyBackup] come from LegacyRnStoreGuard; both are "" for the dev database. */
    fun start(bundle: String, legacyState: String = "", legacyBackup: String = ""): JSONObject = onEngine {
        try {
            val engine = QuickJSContext.create()
            context = engine
            val database = SqliteBridge(databaseFile)
            sqlite = database
            database.ensureRecoveryCheckpoint()
            val bridge = engine.createNewJSObject()
            bridge.setProperty("sqlRun", guarded { args -> database.run(args[0] as String, args[1] as String); null })
            bridge.setProperty("sqlAll", guarded { args -> database.all(args[0] as String, args[1] as String) })
            bridge.setProperty("sqlExec", guarded { args -> database.exec(args[0] as String); null })
            bridge.setProperty("nowMs", guarded { _ -> (System.nanoTime() - startedAt) / 1e6 })
            bridge.setProperty("randomBytes", guarded { args ->
                val length = (args[0] as Number).toInt()
                require(length in 0..65_536) { "Invalid random byte count" }
                JSONArray().also { out ->
                    ByteArray(length).also(random::nextBytes).forEach { out.put(it.toInt() and 0xff) }
                }.toString()
            })
            // `{ clearJsonAhead, setReconciled }`, decided by core's planLegacyJsonImport after the saved import is read back.
            bridge.setProperty("rnStateCommit", guarded { args ->
                val change = JSONObject(args[0] as String)
                LegacyRnStoreGuard.commitRnState(checkNotNull(rnDataDir) { "No React Native state in this build" },
                    change.getBoolean("clearJsonAhead"), change.getBoolean("setReconciled"))
                null
            })
            // A diagnostic line must never fail the caller: coerce and swallow.
            bridge.setProperty("log", guarded { args -> runCatching { Log.i(TAG, args.getOrNull(0).toString()) }; null })
            engine.globalObject.setProperty("__mindwtrNative", bridge)
            engine.evaluate(bundle, "core-host.js")
            callAsync("boot", legacyState, legacyBackup)
        } catch (error: Throwable) {
            closeOnEngine()
            throw error
        }
    }

    fun inboxWindow(offset: Int, limit: Int, revision: String): JSONObject =
        callAsync("window", offset, limit, revision)

    /** Core's getFocus: its sections in its order, the first [limit] rows of each. */
    fun focus(limit: Int): JSONObject = callAsync("focus", limit)

    /** Core's getFocusSectionWindow. A changed Focus fails with "STALE_REVISION: …". */
    fun focusWindow(key: String, offset: Int, limit: Int, revision: String): JSONObject =
        callAsync("focusWindow", key, offset, limit, revision)

    /** Core's openQuickCapture: the popup's empty draft and its starting options. */
    fun openQuickCapture(): JSONObject = callAsync("captureOpen")

    /** Core's getQuickCaptureView with [json] (`{ text, options, picker? }`) unchanged. */
    fun quickCaptureView(json: String): JSONObject = callAsync("captureView", json)

    /** Core's editQuickCapture with [json] (`{ text, options, edit, picker? }`) unchanged. */
    fun editQuickCapture(json: String): JSONObject = callAsync("captureEdit", json)

    /** Core's submitQuickCapture with [json] unchanged; its captureId makes a retry exact. */
    fun submitQuickCapture(json: String): JSONObject = callAsync("captureSubmit", json)

    /** Core's createQuickCaptureSnapshot, as `{ snapshot: { fileName, contents } | null }`. */
    fun createQuickCaptureSnapshot(): JSONObject = callAsync("captureSnapshot")

    /** Core's submitQuickCaptureLines with [json] unchanged; one capture ID per line. */
    fun submitQuickCaptureLines(json: String): JSONObject = callAsync("captureLines", json)

    /** Core's submitQuickCapturePickerQuery with [json] unchanged; its requestId makes a create's retry exact. */
    fun submitQuickCapturePickerQuery(json: String): JSONObject = callAsync("capturePicker", json)

    fun completeTask(id: String): JSONObject = callAsync("complete", id)

    /** Core's setTaskFocus to the target [focused]. A reply with `blocked` wrote nothing. */
    fun setTaskFocus(id: String, focused: Boolean): JSONObject = callAsync("taskFocus", id, focused)

    /** Core's setProjectFocus to the target [focused]. `{ blocked: "" }` wrote nothing. */
    fun setProjectFocus(id: String, focused: Boolean): JSONObject = callAsync("projectFocus", id, focused)

    /** Core's createProject; [areaId] "" is no area, and [requestId] is kept for the exact retry. */
    fun createProject(title: String, areaId: String, requestId: String): JSONObject =
        callAsync("createProject", title, areaId, requestId)

    /** Core's getAreaFilter: the trigger label, the summary, and each option with its `next` selection. */
    fun areaFilter(): JSONObject = callAsync("areaFilter")

    /** Core's setAreaFilter with one of getAreaFilter's `next` selections, unchanged. */
    fun setAreaFilter(selectionJson: String): JSONObject = callAsync("setAreaFilter", selectionJson)

    /** Core's searchTasks with [json] (`{ query, filters, limit }`) unchanged. */
    fun searchTasks(json: String): JSONObject = callAsync("search", json)

    /** Core's saveSearch with [json] (`{ query, name, requestId }`) unchanged. */
    fun saveSearch(json: String): JSONObject = callAsync("saveSearch", json)

    /** Core's startInboxProcessing in [mode] ('guided' or 'quick'). */
    fun startInboxProcessing(mode: String): JSONObject = callAsync("inboxStart", mode)

    /** Core's getInboxProcessingStep with [json] unchanged: one edit or a mode, for the step on screen. */
    fun inboxProcessingStep(json: String): JSONObject = callAsync("inboxStep", json)

    /** Core's commitInboxProcessingStep with [json] unchanged; its requestId makes a retry exact. */
    fun commitInboxProcessingStep(json: String): JSONObject = callAsync("inboxCommit", json)

    /** Core's skipInboxProcessingTask with [json] unchanged. */
    fun skipInboxProcessingTask(json: String): JSONObject = callAsync("inboxSkip", json)

    /** Core's endInboxProcessing; it writes nothing. */
    fun endInboxProcessing(sessionId: String): JSONObject = callAsync("inboxEnd", sessionId)

    /** Core's getTaskEditorModel for one task: its draft, the fields to show by section, and each field's choices. */
    fun taskEditorModel(id: String): JSONObject = callAsync("editorModel", id)

    /**
     * Core's editTaskDraft: the editor model for [draftJson] after one control's edit ([editJson], "" for none).
     * It writes nothing; the editor saves the returned draft with saveTaskDraft.
     */
    fun editTaskDraft(id: String, draftJson: String, editJson: String): JSONObject =
        callAsync("editDraft", JSONObject().put("id", id).put("draft", JSONObject(draftJson))
            .apply { if (editJson.isNotEmpty()) put("edit", JSONObject(editJson)) }.toString())

    /** The task's checklist and attachment titles from core's getTask, shown read-only in the editor. */
    fun editorContent(id: String): JSONObject = callAsync("editorContent", id)

    /** Core's getTaskEditorSuggestions for a context, tag, or person input's whole text as typed. */
    fun editorSuggestions(id: String, field: String, query: String, limit: Int): JSONObject =
        callAsync("editorSuggestions", id, field, query, limit)

    /** [baseJson] and [patchJson] go to core's saveTaskDraft unchanged; core decides everything. */
    fun saveTaskDraft(id: String, baseJson: String, patchJson: String): JSONObject =
        callAsync("saveDraft", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson)).toString())

    /** The status menu and the Restore and Next swipes: [baseJson] and [patchJson] go to core's updateTask unchanged. */
    fun updateTask(id: String, baseJson: String, patchJson: String): JSONObject =
        callAsync("update", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson)).toString())

    /**
     * Core's setLanguage: [stored] is RN's saved language ("" for none), [system] the device locale tag.
     * A debug build lets `debug.mindwtr.native.language` replace [stored] for the language check.
     */
    fun language(stored: String, system: String): JSONObject =
        callAsync("language", debugFault("language").ifEmpty { stored }, system)

    /** Core's getStrings for [keys], in the language core chose. */
    fun strings(keys: List<String>): JSONObject = callAsync("strings", JSONArray(keys).toString())

    /** RN's theme as core resolves it: [stored] is RN's device-local `@mindwtr_theme` ("" for none). */
    fun theme(stored: String): JSONObject = callAsync("theme", stored)

    /** Core's getProjects: its Active, Deferred, and Archived groups in its order. */
    fun projects(): JSONObject = callAsync("projects")

    /** Core's getProjectDetail. A changed project fails with "STALE_REVISION: …". */
    fun projectDetail(id: String, offset: Int, limit: Int, revision: String): JSONObject =
        callAsync("projectDetail", id, offset, limit, revision)

    /**
     * Debug-build fault injection for the device checks, and the language override at boot.
     * Read once per task command, on the engine thread. Release builds return
     * "" before reading anything, so no property can reach them.
     */
    private fun debugFault(name: String): String = debugProperty(name)

    private fun debugDelay(name: String) {
        val ms = debugFault(name).toLongOrNull() ?: return
        if (ms > 0) Thread.sleep(minOf(ms, 60_000L))
    }

    private fun callAsync(method: String, vararg args: Any?): JSONObject = onEngine {
        val command = method in setOf("captureSubmit", "captureLines", "capturePicker", "complete", "update", "saveDraft", "taskFocus", "projectFocus", "createProject", "setAreaFilter",
            "saveSearch", "inboxCommit", "inboxSkip")
        if (command) {
            checkNotNull(sqlite).failCommits = debugFault("fail_commit") == "1"
            debugDelay("delay_before_ms")
        }
        val id = call(method, *args) as String
        val engine = checkNotNull(context)
        val pump = engine.globalObject.getJSFunction("__pumpTimers")
        val nextDelay = engine.globalObject.getJSFunction("__nextTimerDelay")
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            pump.call()
            val answer = call("poll", id) as String?
            if (answer != null) {
                val result = JSONObject(answer)
                if (command) debugDelay("delay_after_ms")
                if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
                return@onEngine result.getJSONObject("value")
            }
            val delay = (nextDelay.call() as? Number)?.toLong() ?: 1L
            if (delay > 0) Thread.sleep(minOf(delay, 25L))
        }
        throw IllegalStateException("Core $method timed out")
    }

    private fun closeOnEngine() {
        functions.clear()
        hostObject = null
        try {
            sqlite?.close()
        } finally {
            sqlite = null
            context?.destroy()
            context = null
        }
    }

    fun close() {
        check(Thread.currentThread() !== engineThread) { "Core host cannot close itself" }
        val task = synchronized(lifecycleLock) {
            shutdown ?: executor.submit(Callable { closeOnEngine() }).also {
                shutdown = it
                executor.shutdown()
            }
        }
        task.get()
    }
}

/**
 * A device check's debug property `debug.mindwtr.native.<name>`. Release builds return "" before reading anything,
 * so no property can reach them.
 */
fun debugProperty(name: String): String {
    if (!BuildConfig.DEBUG) return ""
    return runCatching {
        val process = ProcessBuilder("getprop", "debug.mindwtr.native.$name").start()
        process.inputStream.bufferedReader().use { it.readText().trim() }.also { process.waitFor() }
    }.getOrDefault("")
}
