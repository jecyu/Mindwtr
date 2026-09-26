package tech.dongdongbh.mindwtr.pilot

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.text
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.core.view.WindowCompat

/**
 * Isolated development UI, drawn as the React Native app draws it: its header, its bottom
 * tab bar with the center capture button, its theme tokens, and its task row. Task rules
 * and writes stay in the shared core; every label comes from core's getStrings.
 */
class MainActivity : ComponentActivity() {
    private val model: InboxViewModel by viewModels()

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model.attach()
        setContent {
            // Core resolves RN's theme during the boot; until it ends, RN's default follows the system.
            MindwtrTheme(if (model.loading) null else ThemeChoice.current) { with(model) {
                val theme = LocalTheme.current
                val c = theme.colors
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !theme.isDark
                        isAppearanceLightNavigationBars = !theme.isDark
                    }
                }
                val open = editor
                val flow = processing?.takeUnless { it.hidden }
                val searching = search
                // Full-screen flows over the tabs, as RN presents them: the editor, then Process Inbox, then search.
                if (open != null && writable) TaskEditorScreen(model, open)
                else if (flow != null && writable) ProcessInboxScreen(model, flow)
                else if (searching != null && writable) SearchScreen(model, searching)
                else Column(
                    Modifier.fillMaxSize().background(c.cardBg).systemBarsPadding().semantics { testTagsAsResourceId = true },
                ) {
                    if (loading) {
                        CircularProgressIndicator(Modifier.padding(24.dp))
                    } else if (!writable) {
                        // The boot failed: no command can run, and core's labels may never have loaded.
                        Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("boot-failure").padding(24.dp))
                    } else {
                        // An open project draws its own header, as RN's project screen does. In landscape the
                        // selected tab already names the screen, so the title bar gives its height to the rows.
                        val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
                        if ((screen != Screen.Projects || openProjectId == null) && !landscape) TopBar(model, t(screen.label))
                        // A failure stays in view above the list. A failed read offers Try again; a failed command only its exact retry.
                        error?.let { message ->
                            FailureBanner(message) {
                                if (failedAction == null) TextButton(onClick = { refresh() }, enabled = !busy, modifier = Modifier.testTag("read-retry")) { Text(t("common.retry")) }
                                else OwedRetry(model)
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            Column(Modifier.fillMaxSize()) {
                                // Three lists in one Activity: tabs, no navigation library. The editor opens over the selected list.
                                Box(Modifier.weight(1f).fillMaxWidth().background(c.bg).clipToBounds()) {
                                    when (screen) {
                                        Screen.Inbox -> InboxList(model, Modifier.fillMaxSize())
                                        Screen.Focus -> FocusList(model, Modifier.fillMaxSize())
                                        Screen.Projects -> ProjectsTab(model, Modifier.fillMaxSize())
                                    }
                                }
                                TabBar(model)
                            }
                            // The capture popup shows its own toasts above its keyboard, as RN's sheet does.
                            if (capture == null) ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 78.dp))
                            capture?.let { CapturePopup(model, it) }
                            if (areaSheet) AreaSheet(model)
                            StatusMenu(model)
                        }
                    }
                }
            } }
        }
    }
}

/** A 1 px rule, as RN's StyleSheet.hairlineWidth, along the top or bottom edge. */
fun Modifier.hairline(color: Color, top: Boolean) = drawBehind {
    val y = if (top) 0f else size.height - 1f
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
}

/**
 * RN's tab header: card background, a hairline below, the title centered at 17/700, RN's
 * area switcher at the left, and RN's search button (22, in a 44 box) at the right.
 */
@Composable
private fun TopBar(model: InboxViewModel, title: String) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().height(56.dp).background(c.cardBg).hairline(c.border, top = false), contentAlignment = Alignment.Center) {
        Text(title, style = rnText(17, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 72.dp).semantics { heading() })
        AreaTrigger(model, Modifier.align(Alignment.CenterStart).padding(start = 16.dp))
        val label = t("search.title")
        Box(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(44.dp)
            .clickable(enabled = model.failedAction == null, role = Role.Button) { model.openSearch() }
            .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
            Icon(Lucide.Search, null, tint = c.text, modifier = Modifier.size(22.dp))
        }
    }
}

/**
 * The failure, pinned above the list. It is drawn above the list (zIndex), so a
 * partly scrolled-out row can never cover it in the accessibility tree; TalkBack
 * hears it at once (live region) and reaches it first (traversal index).
 */
@Composable
fun FailureBanner(message: String, action: @Composable RowScope.() -> Unit) {
    val c = LocalTheme.current.colors
    Row(
        Modifier.fillMaxWidth().zIndex(1f).background(c.cardBg).hairline(c.border, top = false)
            .semantics { isTraversalGroup = true; traversalIndex = -1f }
            .padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp).heightIn(min = 44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.TriangleAlert, null, tint = c.danger, modifier = Modifier.size(16.dp))
        Text(message, style = rnText(13, 600), color = c.danger,
            modifier = Modifier.weight(1f).padding(start = 8.dp).semantics { liveRegion = LiveRegionMode.Assertive })
        action()
    }
}

/**
 * Try again for an owed command's exact request (InboxViewModel.retryOwed), in every screen's failure banner:
 * a command started where its control is gone (the status menu on Focus, a closed sheet) stays retryable.
 */
@Composable
fun OwedRetry(model: InboxViewModel) {
    if (model.failedAction != null) TextButton(onClick = model::retryOwed, enabled = !model.busy, modifier = Modifier.testTag("owed-retry")) { Text(t("common.retry")) }
}

/**
 * RN's bottom tab bar: Focus, Inbox, the capture button, the quick-access view
 * (Projects), then Menu. Menu has no native screen yet, so its slot stays empty:
 * every control keeps the place an RN user's thumb expects.
 */
@Composable
private fun TabBar(model: InboxViewModel) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().height(66.dp).background(c.cardBg).hairline(c.border, top = true), verticalAlignment = Alignment.CenterVertically) {
        TabItem(model, Screen.Focus, Lucide.Target)
        TabItem(model, Screen.Inbox, Lucide.Inbox)
        CaptureButton(model)
        TabItem(model, Screen.Projects, Lucide.Folder)
        Spacer(Modifier.weight(1f))
    }
}

/** RN's tab: icon 26 when active (24 and 80% opacity when not), label 10 below, tint when active. */
@Composable
private fun RowScope.TabItem(model: InboxViewModel, tab: Screen, icon: ImageVector) = with(model) {
    val c = LocalTheme.current.colors
    val active = screen == tab
    val color = if (active) c.tabIconSelected else c.tabIconDefault
    Column(
        Modifier.weight(1f).fillMaxHeight().selectable(selected = active, role = Role.Tab, onClick = { show(tab) }),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = color, modifier = Modifier.size(if (active) 26.dp else 24.dp).fade(if (active) 1f else 0.8f))
        Text(t(tab.label), style = rnText(10, if (active) 700 else 600, 12), color = color, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    }
}

/** RN's center capture button: a 48x38 tint tile, lifted above the tab labels. It opens the quick capture sheet. */
@Composable
private fun RowScope.CaptureButton(model: InboxViewModel) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(theme.captureRadius)
    val label = t("nav.addTask")
    Box(
        Modifier.weight(1f).fillMaxHeight().clickable(role = Role.Button) { model.openCapture() }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.offset(y = (-6).dp).size(48.dp, 38.dp).shadow(3.dp, shape).clip(shape).background(theme.colors.tint),
            contentAlignment = Alignment.Center) {
            Icon(Lucide.Plus, null, tint = theme.colors.onTint, modifier = Modifier.size(28.dp))
        }
    }
}

/**
 * RN's "Process Inbox (N)": a tint wash with a tint border (Material 3: the filled container), the ListChecks
 * glyph, and core's Inbox count, shown as 99+ above 99; TalkBack hears the exact count, as in RN.
 */
@Composable
private fun ProcessButton(model: InboxViewModel) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val label = t("inbox.processButton")
    val shown = if (total > 99) "99+" else "$total"
    val shape = RoundedCornerShape(12.dp)
    val material = theme.isMaterial
    Row(Modifier.padding(bottom = 12.dp).fillMaxWidth().heightIn(min = 44.dp).clip(shape).background(if (material) theme.filledBg else theme.processWash)
        .then(if (material) Modifier else Modifier.border(1.dp, c.tint, shape))
        .clickable(enabled = writable && !busy && failedAction == null, role = Role.Button) { openProcessing() }
        .semantics { contentDescription = "$label ($total)" }.padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(Lucide.ListChecks, null, tint = if (material) theme.filledText else c.tint, modifier = Modifier.size(18.dp))
        Text("$label ($shown)", style = rnText(15, 600), color = if (material) theme.filledText else c.text, textAlign = TextAlign.Center,
            maxLines = 2, modifier = Modifier.padding(start = 8.dp))
    }
}

/**
 * RN's pill button: filled with the tint (RN's Save) or outlined (RN's empty-state
 * action, and this app's More). [description] replaces the spoken label when set.
 */
@Composable
fun PillButton(label: String, filled: Boolean = false, onClick: () -> Unit, enabled: Boolean, description: String? = null) {
    val c = LocalTheme.current.colors
    Box(
        Modifier.widthIn(min = if (filled) 104.dp else 0.dp).heightIn(min = if (filled) 48.dp else 40.dp).clip(CircleShape)
            .then(if (filled) Modifier.background(c.tint) else Modifier.border(1.dp, c.text, CircleShape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
            .fade(if (enabled) 1f else 0.5f).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = rnText(if (filled) 15 else 13, 700), color = if (filled) c.onTint else c.text)
    }
}

/** RN's ListEmptyState: a bordered card with the message, the hint, and one action. */
@Composable
fun EmptyState(message: String, hint: String?, action: String? = null, onAction: () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .padding(horizontal = 20.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, style = rnText(15, 600), color = c.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        hint?.let { Text(it, style = rnText(13, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp)) }
        action?.let { Box(Modifier.padding(top = 16.dp)) { PillButton(it, onClick = onAction, enabled = true) } }
    }
}

/**
 * A section title as RN draws it: 12/700 capitals in the secondary text color, then
 * the count. TalkBack and the device checks read core's own title and count.
 */
@Composable
fun SectionTitle(title: String, count: Int?, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val spoken = if (count == null) title else "$title · $count"
    Row(modifier.clearAndSetSemantics { text = AnnotatedString(spoken); heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 1f), color = c.secondaryText, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        count?.let { Text("($it)", style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(start = 10.dp)) }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

/**
 * The Inbox as one list: RN's Process Inbox button and scope line scroll with the rows, so landscape
 * shows rows, not chrome.
 */
@Composable
private fun InboxList(model: InboxViewModel, modifier: Modifier) = with(model) {
    val c = LocalTheme.current.colors
    LazyColumn(modifier, contentPadding = PaddingValues(12.dp)) {
        item(key = "header") {
            if (total > 0) ProcessButton(model)
            Text(t("projects.allAreas"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
        }
        if (total == 0) item(key = "empty") {
            EmptyState(t("inbox.empty"), t("inbox.emptyAddHint"), t("nav.addTask")) { openCapture() }
        }
        items(rows, key = { it.id }) { task -> TaskRowItem(model, task, status = RowStatus.Icon) }
        if (rows.size < total) item(key = "more") {
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                PillButton(t("common.more"), onClick = model::loadMore, enabled = writable && !busy && failedAction == null)
            }
        }
    }
}
