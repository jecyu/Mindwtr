package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import org.json.JSONObject

/** One Focus section as core sent it. [focusBlockedLabel] is core's reason every star here can only refuse (Upcoming). */
data class FocusSection(val key: String, val title: String, val total: Int, val rows: List<TaskRow>, val focusBlockedLabel: String?)
/** One of core's "Projects to review" rows: the project, its status, and core's review date text. */
data class ReviewProject(val id: String, val title: String, val status: String, val color: String?, val reviewDate: String?)

/**
 * Core's getFocus reply at one revision. Sections, titles, totals, and rows
 * stay exactly in core's order: Kotlin never sorts, drops, or regroups them.
 * [dateLabel] is core's date line, formatted with the user's settings.
 */
data class FocusView(val revision: String, val dateLabel: String, val sections: List<FocusSection>, val reviewProjects: List<ReviewProject>) {
    fun section(key: String) = sections.firstOrNull { it.key == key }

    /** Adds one getFocusSectionWindow reply after the rows its section already has. */
    fun append(window: JSONObject): FocusView {
        check(window.getInt("version") == 1 && window.getString("revision") == revision) { "Unexpected Focus window" }
        val key = window.getString("key")
        return copy(sections = sections.map { section ->
            if (section.key == key) section.copy(total = window.getInt("total"), rows = section.rows + window.taskRows()) else section
        })
    }

    companion object {
        fun parse(json: JSONObject): FocusView {
            check(json.getInt("version") == 1) { "Unsupported core contract" }
            val items = json.getJSONArray("sections")
            val review = json.getJSONArray("reviewProjects")
            return FocusView(json.getString("revision"), json.getString("dateLabel"), List(items.length()) { index ->
                items.getJSONObject(index).let {
                    FocusSection(it.getString("key"), it.getString("title"), it.getInt("total"), it.taskRows(),
                        if (it.isNull("focusBlockedLabel")) null else it.getString("focusBlockedLabel"))
                }
            }, List(review.length()) { index ->
                review.getJSONObject(index).let {
                    ReviewProject(it.getString("id"), it.getString("title"), it.getString("status"),
                        if (it.isNull("color")) null else it.getString("color"), if (it.isNull("reviewDateLabel")) null else it.getString("reviewDateLabel"))
                }
            })
        }
    }
}

/**
 * Focus as core sent it, in one list, drawn as RN's Focus: core's date line with RN's
 * "Focus only / Expand sections" button, then each section with RN's triangle, title and
 * count. A section core counts as empty is not drawn, as in RN. A tap on a title folds the
 * section; the open sections are kept on the device as RN keeps them. Core's "Later today"
 * label goes before the first row core flags `laterToday`. "Projects to review" follows.
 */
@Composable
fun FocusList(model: InboxViewModel, modifier: Modifier) {
    // Core's Focus changes with the clock. Read it again on every resume and each
    // minute while this list shows; the loop stops when the screen pauses or leaves.
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                model.refreshFocus()
                delay(60_000)
            }
        }
    }
    with(model) {
        val c = LocalTheme.current.colors
        val more = t("common.more")
        LazyColumn(modifier, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 12.dp)) {
            val view = focus
            val sections = view?.sections.orEmpty()
            val reviewCount = view?.reviewProjects?.size ?: 0
            val shown = sections.count { it.total > 0 }
            // RN's toggle acts on every shown section but Today's Focus.
            val others = sections.count { it.total > 0 && it.key != "focus" } + (if (reviewCount > 0) 1 else 0)
            val othersOpen = sections.any { it.total > 0 && it.key != "focus" && focusView.isOpen(it.key) } ||
                (reviewCount > 0 && focusView.isOpen("reviewProjects"))
            if (view != null) item(key = "date") {
                Row(Modifier.fillMaxWidth().padding(top = 6.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(view.dateLabel.uppercase(), style = rnText(12, 600, letterSpacing = 0.6f), color = c.secondaryText,
                        modifier = Modifier.weight(1f))
                    val label = t(if (othersOpen) "agenda.collapseOtherSections" else "agenda.expandOtherSections")
                    IconButton(onClick = { setOtherFocusSections(!othersOpen) }, enabled = others > 0,
                        modifier = Modifier.fade(if (others > 0) 1f else 0.4f).semantics { contentDescription = label; selected = !othersOpen }) {
                        Icon(if (othersOpen) Lucide.ChevronsUp else Lucide.ChevronsDown, null,
                            tint = if (othersOpen) c.secondaryText else c.tint, modifier = Modifier.size(20.dp))
                    }
                }
            }
            // RN's empty Focus: its "All Clear!" title and hint, centered.
            if (view != null && shown == 0 && reviewCount == 0) item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(t("agenda.allClear"), style = rnText(16, 700), color = c.text, textAlign = TextAlign.Center)
                    Text(t("agenda.noTasks"), style = rnText(12, 600), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp))
                }
            }
            var first = true
            for (section in focus?.sections.orEmpty()) {
                if (section.total == 0) continue
                val open = focusView.isOpen(section.key)
                item(key = "title:${section.key}") {
                    FocusSectionTitle(section.title, section.total, open, first) { toggleFocusSection(section.key) }
                }
                first = false
                if (!open) continue
                val laterToday = section.rows.indexOfFirst { it.laterToday }
                section.rows.forEachIndexed { index, task ->
                    if (index == laterToday) item(key = "later:${section.key}") {
                        SectionTitle(t("agenda.laterToday"), null, Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp, start = 4.dp))
                    }
                    item(key = "${section.key}:${task.id}") {
                        TaskRowItem(model, task, status = if (section.key == "reviewDue") RowStatus.Badge else RowStatus.Hidden,
                            star = RowStar.Shown, starBlocked = section.focusBlockedLabel, focusHighlight = section.key != "focus")
                    }
                }
                if (section.rows.size < section.total) item(key = "more:${section.key}") {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        PillButton(more, onClick = { loadMoreFocus(section.key) }, enabled = writable && !busy && failedAction == null,
                            description = "$more ${section.title}")
                    }
                }
            }
            if (reviewCount > 0) {
                val open = focusView.isOpen("reviewProjects")
                item(key = "title:reviewProjects") {
                    FocusSectionTitle(t("agenda.reviewDueProjects"), reviewCount, open, first) { toggleFocusSection("reviewProjects") }
                }
                if (open) for (project in view!!.reviewProjects) item(key = "review:${project.id}") { ReviewProjectCard(model, project) }
            }
        }
    }
}

/** RN's Focus section header: ▾ or ▸, the title in capitals, and the count. TalkBack hears core's title and count. */
@Composable
private fun FocusSectionTitle(title: String, count: Int, open: Boolean, first: Boolean, onToggle: () -> Unit) {
    val c = LocalTheme.current.colors
    val state = t(if (open) "markdown.collapse" else "markdown.expand")
    val spoken = "$title · $count"
    Row(
        Modifier.fillMaxWidth().padding(top = if (first) 8.dp else 18.dp, bottom = 10.dp)
            .clearAndSetSemantics {
                text = AnnotatedString(spoken); heading()
                onClick(label = state) { onToggle(); true }
            }
            .clickable(onClick = onToggle).padding(start = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (open) "▾" else "▸", style = rnText(12, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.width(14.dp))
        Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 1f), color = c.secondaryText, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f, fill = false))
        Text("($count)", style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(start = 10.dp))
    }
}

/** RN's review card: the folder tile (the project color as its border), the title, the status, and core's review date. A tap opens the project. */
@Composable
private fun ReviewProjectCard(model: InboxViewModel, project: ReviewProject) = with(model) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(14.dp)
    val label = "${t("common.open")} ${project.title}"
    Row(
        Modifier.padding(bottom = 8.dp).fillMaxWidth().heightIn(min = 72.dp).clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .clickable(enabled = writable && !busy && failedAction == null, role = Role.Button) { show(Screen.Projects); openProject(project.id) }
            .clearAndSetSemantics { contentDescription = label }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tile = RoundedCornerShape(10.dp)
        Box(Modifier.size(36.dp).clip(tile).background(c.filterBg).border(1.dp, coreColorOrNull(project.color) ?: c.border, tile),
            contentAlignment = Alignment.Center) {
            Icon(Lucide.Folder, null, tint = c.text, modifier = Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(project.title, style = rnText(16, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(t("status.${project.status}"), style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
        project.reviewDate?.let { Text(it, style = rnText(12, 700), color = c.secondaryText, modifier = Modifier.padding(start = 12.dp)) }
    }
}
