package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.FileOutputStream

/**
 * The recovery snapshot a several-lines capture takes first, written as React Native writes it
 * (apps/mobile/lib/recovery-snapshot.ts): core's contents under the app's `snapshots` folder (RN's
 * document directory is this app's files folder), through a temporary file, `.1`, `.2` … before
 * `.snapshot.json` when the name is taken, and only the 5 newest kept.
 */
object RecoverySnapshots {
    private const val MAX_SNAPSHOTS = 5
    private const val MAX_COLLISIONS = 100
    private const val SUFFIX = ".snapshot.json"
    private const val PENDING = "data.pending.snapshot.tmp"
    /** RN's SNAPSHOT_FILE_PATTERN: the instant, its milliseconds, and the clash number. */
    private val PATTERN = Regex("""^data\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:\.(\d{3})(?:\.(\d+))?)?\.snapshot\.json$""")

    /** Writes [contents] as core's [fileName] (or its clash-numbered twin) and returns the name written. */
    fun write(dir: File, fileName: String, contents: String): String {
        dir.mkdirs()
        var name = fileName
        var clash = 0
        while (File(dir, name).exists()) {
            clash += 1
            check(clash <= MAX_COLLISIONS) { "Snapshot storage already holds too many snapshots from this instant." }
            name = fileName.removeSuffix(SUFFIX) + ".$clash$SUFFIX"
        }
        val pending = File(dir, PENDING)
        try {
            FileOutputStream(pending).use { out -> out.write(contents.toByteArray()); out.fd.sync() }
            check(pending.renameTo(File(dir, name))) { "Cannot save the recovery snapshot" }
        } catch (failure: Throwable) {
            pending.delete()
            throw failure
        }
        prune(dir)
        return name
    }

    /** RN's pruneSnapshots: newest first by instant, then by clash number; all but the 5 newest go. */
    private fun prune(dir: File) {
        val entries = dir.listFiles().orEmpty().mapNotNull { file ->
            PATTERN.matchEntire(file.name)?.let { match ->
                Triple(file, "${match.groupValues[1]}.${match.groupValues[2].ifEmpty { "000" }}", match.groupValues[3].toIntOrNull() ?: 0)
            }
        }.sortedWith(compareByDescending<Triple<File, String, Int>> { it.second }.thenByDescending { it.third })
        entries.drop(MAX_SNAPSHOTS).forEach { runCatching { it.first.delete() } }
    }
}
