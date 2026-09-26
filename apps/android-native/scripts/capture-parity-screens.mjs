// Side-by-side screenshots of the React Native app and the native Android app on one fixture.
//
//   node apps/android-native/scripts/build-upgrade-harness.mjs     (once: builds the APKs)
//   node apps/android-native/scripts/capture-parity-screens.mjs <adb-serial>
//
// Bun builds one fixture database through core's own store: 2 areas, 3 projects (one
// sequential, with sections), 20 tasks with contexts, dates, priorities, notes, and one
// starred task, and RN's quick-access tab set to Projects so both tab bars show the same
// tabs. The script installs the harness RN build (154), puts the fixture in as its
// database, and shoots Inbox, Focus, Projects, the task editor (Form tab) for one
// task opened from Focus, global search for "kitchen", Process Inbox's first step, and the
// capture popup (empty, with text and core's preview, and with the contexts picker open), in
// light and dark mode. Then it installs
// the native upgradetest build (153) over it, on the same database, and shoots the same
// screens. It writes rn-*.png, native-*.png, and side-by-side pair-*.png (RN left) to
// /home/dd/.mindwtr-harness/parity/<timestamp>/.
//
// It touches only tech.dongdongbh.mindwtr.upgradetest: it refuses any other APK, sends
// input only while that package is in front, and at the end uninstalls it and restores
// night mode and rotation. Leave the phone on its home screen. Exit 0 = shots taken,
// 1 = failed, 2 = refused, 3 = stopped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { button, check, connect, evidenced, hasText, inEditor, inList, Stopped, tab, tabSelected } from './device.mjs';

const [serial] = process.argv.slice(2);
if (!serial) {
    console.error('usage: node capture-parity-screens.mjs <adb-serial>');
    process.exit(2);
}
const PKG = 'tech.dongdongbh.mindwtr.upgradetest';
const RN_ACTIVITY = `${PKG}/${PKG}.MainActivity`;
const NATIVE_ACTIVITY = `${PKG}/tech.dongdongbh.mindwtr.pilot.MainActivity`;
const harness = process.env.MINDWTR_HARNESS_DIR ?? '/home/dd/.mindwtr-harness';
const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
const coreSrc = resolve(import.meta.dirname, '../../../packages/core/src');
const out = resolve(harness, 'parity', new Date().toISOString().replace(/[:.]/g, '-'));
let apks;
try {
    const built = JSON.parse(readFileSync(resolve(harness, 'apks/manifest.json'), 'utf8'));
    apks = { rn: built.rn154.path, native: built.native153.path };
} catch {
    console.error(`REFUSED: no ${harness}/apks/manifest.json; run build-upgrade-harness.mjs first`);
    process.exit(2);
}
for (const apk of Object.values(apks)) {
    if (execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim() !== PKG) {
        console.error(`REFUSED: ${apk} is not ${PKG}`);
        process.exit(2);
    }
}

// ---- the fixture, built through core's store in Bun ----
const T = {
    call: 'Call the plumber about the leak', receipts: 'Scan last month\'s receipts', gift: 'Gift idea for Sam\'s birthday',
    article: 'Read the article on habit tracking', dentist: 'Book a dentist appointment', bikes: 'Look into e-bike prices',
    tiles: 'Choose kitchen tiles', quote: 'Ask for a countertop quote', paint: 'Paint the kitchen walls',
    outline: 'Draft the report outline', numbers: 'Collect Q3 sales numbers', review: 'Review the slides with Priya',
    flights: 'Compare flight prices', hotel: 'Shortlist three hotels', passport: 'Renew passport',
    milk: 'Buy milk and eggs', invoice: 'Send the March invoice', backup: 'Back up the laptop',
    mom: 'Call Mom back', taxes: 'Gather tax documents',
};
const fixture = resolve(out, 'fixture/mindwtr.db');
const buildFixture = () => execFileSync('bun', ['-e', `
    import { Database } from 'bun:sqlite';
    import { SqliteAdapter, createNativeHostContract, flushPendingSave, setStorageAdapter, useTaskStore } from '${coreSrc}/index.ts';
    const db = new Database(process.env.FIXTURE_DB, { create: true });
    const client = {
        run: async (sql, params = []) => { db.query(sql).run(...params); },
        all: async (sql, params = []) => db.query(sql).all(...params),
        get: async (sql, params = []) => db.query(sql).get(...params) ?? undefined,
        exec: async (sql) => { db.exec(sql); },
    };
    setStorageAdapter(new SqliteAdapter(client));
    const ready = await createNativeHostContract().activate({ writeSafetyReady: true });
    if (!ready.ok) throw new Error(ready.error.message);
    const T = JSON.parse(process.env.FIXTURE_TITLES);
    const store = () => useTaskStore.getState();
    const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    // One save at a time: core's incremental saves share this one connection.
    const add = async (title, props = {}) => {
        const result = await store().addTask(title, props);
        if (!result.success) throw new Error('addTask failed: ' + result.error);
        await flushPendingSave();
    };
    const home = await store().addArea('Home', { color: '#10b981' });
    const work = await store().addArea('Work', { color: '#3b82f6' });
    const kitchen = await store().addProject('Kitchen renovation', '#f59e0b', { areaId: home.id, isSequential: true });
    const report = await store().addProject('Quarterly report', '#3b82f6', { areaId: work.id });
    const trip = await store().addProject('Plan summer trip', '#8b5cf6', { areaId: home.id });
    const design = await store().addSection(kitchen.id, 'Design');
    const build = await store().addSection(kitchen.id, 'Build');
    await flushPendingSave();
    for (const title of [T.call, T.receipts, T.gift, T.article, T.dentist, T.bikes]) await add(title, { status: 'inbox' });
    await add(T.tiles, { status: 'next', projectId: kitchen.id, sectionId: design.id, contexts: ['@errands'], dueDate: day(2) });
    await add(T.quote, { status: 'next', projectId: kitchen.id, sectionId: design.id, contexts: ['@phone'] });
    await add(T.paint, { status: 'next', projectId: kitchen.id, sectionId: build.id, description: 'Two coats, the light grey from the sample.' });
    await add(T.outline, { status: 'next', projectId: report.id, contexts: ['@computer'], priority: 'high', dueDate: day(0), isFocusedToday: true });
    await add(T.numbers, { status: 'next', projectId: report.id, contexts: ['@computer'], priority: 'medium', dueDate: day(1) });
    await add(T.review, { status: 'waiting', projectId: report.id, contexts: ['@office'] });
    await add(T.flights, { status: 'next', projectId: trip.id, contexts: ['@computer'], priority: 'low' });
    await add(T.hotel, { status: 'next', projectId: trip.id, startTime: day(3), description: 'Near the old town, with breakfast.' });
    await add(T.passport, { status: 'someday', projectId: trip.id });
    await add(T.milk, { status: 'next', contexts: ['@errands'], areaId: home.id, dueDate: day(0) });
    await add(T.invoice, { status: 'next', contexts: ['@computer'], areaId: work.id, priority: 'urgent', dueDate: day(-1) });
    await add(T.backup, { status: 'next', contexts: ['@computer'], dueDate: day(6) });
    await add(T.mom, { status: 'next', contexts: ['@phone'] });
    await add(T.taxes, { status: 'someday', areaId: work.id, description: 'W-2, bank statements, receipts folder.' });
    await store().updateSettings({ appearance: { mobileQuickAccessView: 'projects' } });
    await flushPendingSave();
    if (store().persistenceFailure) throw new Error('save failed: ' + store().persistenceFailure.message);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(store()._allTasks.filter((task) => !task.deletedAt).length);
    process.exit(0);
`], { encoding: 'utf8', env: { ...process.env, FIXTURE_DB: fixture, FIXTURE_TITLES: JSON.stringify(T) } }).trim().split('\n').pop();

// ---- the device ----
const device = connect({ serial, pkg: PKG, uiFile: '/data/local/tmp/mindwtr-parity-ui.xml' });
const { adbRaw, sh, home, front, requireAppFront, pid, waitFor, tap } = device;
const runAs = (command) => sh(`run-as ${PKG} ${command}`);
const installed = () => sh(`pm list packages ${PKG}`).split('\n').some((line) => line.trim() === `package:${PKG}`);
const originalNight = /Night mode: (\w+)/.exec(sh('cmd uimode night'))?.[1] ?? 'auto';
const originalAccelerometer = sh('settings get system accelerometer_rotation');
const originalRotation = sh('settings get system user_rotation');
const shots = [];

const stopApp = async () => {
    sh(`am force-stop ${PKG}`);
    await waitFor('the app process to end', () => pid() === '', 10_000);
};
const setNight = async (mode) => {
    sh(`cmd uimode night ${mode}`);
    await sleep(2500); // the app redraws (RN) or is recreated (native) in the new mode
};
/** Waits for [text] (a fixture title or a tab label), then saves a screenshot; a missing text is reported, not fatal. */
const shoot = async (name, ready) => {
    try { await waitFor(`${name} to show`, ready, 45_000); } catch { console.log(`warn - ${name}: expected content not found; shot taken anyway`); }
    await sleep(1200);
    requireAppFront();
    const file = resolve(out, `${name}.png`);
    writeFileSync(file, adbRaw('exec-out', 'screencap', '-p'));
    shots.push(name);
    console.log(`shot ${basename(file)}`);
};
const openLink = (path) => {
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    sh(`am start -W -a android.intent.action.VIEW -d 'mindwtr-upgradetest://${path}' ${PKG}`);
};
/** The task whose editor is shot: opened from Focus, where it has a project, a context, a priority, and a due date. */
const EDITOR_TASK = T.outline;
/** Opens the editor for EDITOR_TASK from the Focus screen on show, shoots it, and closes it with Back (nothing was edited). */
const shootEditor = async (name, rn) => {
    const nodes = await waitFor(`${EDITOR_TASK} in Focus`, (current) => Boolean(inList(current, EDITOR_TASK)), 45_000);
    await tap(inList(nodes, EDITOR_TASK));
    const formShown = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === EDITOR_TASK)
        && (rn || inEditor(current));
    // RN may open on its View tab (Edit | Preview tabs, no title field); its Edit tab is the Form tab this app builds.
    const rnTabs = (current) => rn && hasText(current, 'Preview') && Boolean(button(current, 'Edit'));
    const open = await waitFor(`the editor for ${EDITOR_TASK}`, (current) => formShown(current) || rnTabs(current), 30_000);
    if (!formShown(open)) await tap(button(open, 'Edit'));
    await shoot(name, formShown);
    const editorOpen = (current) => formShown(current) || rnTabs(current);
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('the editor to close', (current) => !editorOpen(current), 15_000);
};
/** Core's en `inbox.processButton` with the fixture's six Inbox tasks: the button's spoken label in both apps. */
const PROCESS = 'Process Inbox (6)';
const SEARCH_QUERY = 'kitchen';
/** Closes the keyboard if it shows, so the shot matches RN's (its search opened by link leaves the keyboard down). */
const hideKeyboard = async () => {
    if (!/mInputShown=true/.test(sh('dumpsys input_method'))) return;
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await sleep(800);
};
/** Opens Process Inbox from the Inbox on show, shoots its first step (the fixture's first Inbox task), and closes it with Back. */
const shootProcess = async (name) => {
    const nodes = await waitFor('the Process Inbox button', (current) => current.some((node) => node['content-desc'] === PROCESS), 45_000);
    await tap(nodes.find((node) => node['content-desc'] === PROCESS));
    const shown = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === T.call);
    await shoot(name, shown);
    await hideKeyboard();
    requireAppFront();
    sh('input keyevent KEYCODE_BACK');
    await waitFor('Process Inbox to close', (current) => !shown(current), 15_000);
};
/**
 * The capture popup from the tab bar's + (both apps label it core's nav.addTask): empty, then with a typed draft
 * and its preview, then with the contexts picker open. Back closes it (the first Back may only close the keyboard).
 */
const CAPTURE_TEXT = 'Call Sam @phone #home';
const shootPopup = async (prefix, suffix) => {
    const nodes = await waitFor('the + button', (current) => current.some((node) => node['content-desc'] === 'Add Task'), 30_000);
    await tap(nodes.find((node) => node['content-desc'] === 'Add Task'));
    const field = (current) => current.find((node) => node.class === 'android.widget.EditText');
    await shoot(`${prefix}-popup-empty-${suffix}`, (current) => Boolean(field(current)));
    requireAppFront();
    sh(`input text '${CAPTURE_TEXT.replace(/ /g, '%s')}'`);
    await shoot(`${prefix}-popup-text-${suffix}`, (current) => field(current)?.text === CAPTURE_TEXT && hasText(current, '@phone'));
    const chip = await waitFor('the contexts chip', (current) => current.some((node) => node['content-desc']?.startsWith('Contexts: ')), 15_000);
    await tap(chip.find((node) => node['content-desc']?.startsWith('Contexts: ')));
    await shoot(`${prefix}-popup-picker-${suffix}`, (current) => current.some((node) => node.text === 'Clear'));
    for (let attempt = 0; attempt < 3 && (await device.screen()).some((node) => node.class === 'android.widget.EditText'); attempt += 1) {
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(800);
    }
};
const SCREENS = [
    { name: 'inbox', link: 'inbox', tab: 'Inbox', text: T.call },
    { name: 'focus', link: 'focus', tab: 'Focus', text: T.outline },
    { name: 'projects', link: 'projects', tab: 'Projects', text: 'Kitchen renovation' },
];

try {
    mkdirSync(resolve(out, 'fixture'), { recursive: true });
    const current = front();
    if (!current.includes(`${PKG}/`) && !current.includes(`${home}/`)) throw new Stopped(`another app is in front: ${current.trim()}`);
    check(Number(buildFixture()) === Object.keys(T).length, `fixture built through core: ${Object.keys(T).length} tasks (${fixture})`);
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');

    // RN 154, fresh, with the fixture as its database before its first launch.
    if (installed()) sh(`pm uninstall ${PKG}`);
    adbRaw('install', '-g', apks.rn);
    runAs('mkdir -p files/SQLite');
    adbRaw('push', fixture, '/data/local/tmp/mindwtr-parity.db');
    try { runAs('cp /data/local/tmp/mindwtr-parity.db files/SQLite/mindwtr.db'); } finally { sh('rm -f /data/local/tmp/mindwtr-parity.db'); }
    device.launch(RN_ACTIVITY);
    for (const mode of ['no', 'yes']) {
        await setNight(mode);
        for (const screen of SCREENS) {
            openLink(screen.link);
            await shoot(`rn-${screen.name}-${mode === 'yes' ? 'dark' : 'light'}`, (nodes) => hasText(nodes, screen.text));
        }
        openLink('focus');
        await shootEditor(`rn-editor-${mode === 'yes' ? 'dark' : 'light'}`, true);
        openLink(`global-search?q=${SEARCH_QUERY}`);
        await shoot(`rn-search-${mode === 'yes' ? 'dark' : 'light'}`, (nodes) => hasText(nodes, 'Kitchen renovation'));
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        await sleep(1000);
        openLink('inbox');
        await shootProcess(`rn-process-${mode === 'yes' ? 'dark' : 'light'}`);
        openLink('inbox');
        await shootPopup('rn', mode === 'yes' ? 'dark' : 'light');
    }
    await stopApp();

    // The native build over it: the same database, the same screens (tabs are tapped; it has no links).
    adbRaw('install', '-r', '-d', '-g', apks.native);
    await setNight('no');
    device.launch(NATIVE_ACTIVITY);
    for (const mode of ['no', 'yes']) {
        if (mode === 'yes') await setNight('yes');
        for (const screen of SCREENS) {
            const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, screen.tab)), 60_000);
            if (!tabSelected(nodes, screen.tab)) await tap(tab(nodes, screen.tab));
            await shoot(`native-${screen.name}-${mode === 'yes' ? 'dark' : 'light'}`, (current) => tabSelected(current, screen.tab) && hasText(current, screen.text));
        }
        const nodes = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Focus')), 60_000);
        if (!tabSelected(nodes, 'Focus')) await tap(tab(nodes, 'Focus'));
        await shootEditor(`native-editor-${mode === 'yes' ? 'dark' : 'light'}`, false);
        // Search from the header's button, the query typed (letters: the parity fixture's titles are words).
        const search = await waitFor('the header Search button', (current) => current.some((node) => node['content-desc'] === 'Search'), 30_000);
        await tap(search.find((node) => node['content-desc'] === 'Search'));
        await waitFor('the search field', (current) => current.some((node) => node.class === 'android.widget.EditText'), 15_000);
        requireAppFront();
        sh(`input text ${SEARCH_QUERY}`);
        // A Pinyin keyboard holds typed letters in its own composition strip and sends none to the field
        // (run 21: the field stayed empty with "kitchen" above the keys). Enter commits the held letters as typed.
        await sleep(800);
        const typed = (current) => current.some((node) => node.class === 'android.widget.EditText' && node.text === SEARCH_QUERY);
        if (!typed(await device.screen())) {
            requireAppFront();
            sh('input keyevent KEYCODE_ENTER');
        }
        await waitFor(`"${SEARCH_QUERY}" in the search field`, typed, 10_000);
        await waitFor('the search results', (current) => hasText(current, 'Kitchen renovation'), 30_000);
        await hideKeyboard();
        await shoot(`native-search-${mode === 'yes' ? 'dark' : 'light'}`, (current) => hasText(current, 'Kitchen renovation'));
        requireAppFront();
        sh('input keyevent KEYCODE_BACK');
        const inboxTab = await waitFor('the native tabs', (current) => Boolean(tab(current, 'Inbox')), 30_000);
        if (!tabSelected(inboxTab, 'Inbox')) await tap(tab(inboxTab, 'Inbox'));
        await shootProcess(`native-process-${mode === 'yes' ? 'dark' : 'light'}`);
        await shootPopup('native', mode === 'yes' ? 'dark' : 'light');
    }
    await stopApp();

    // RN on the left, native on the right.
    const magick = ['magick', 'convert'].find((tool) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; } });
    for (const name of shots.filter((shot) => shot.startsWith('rn-')).map((shot) => shot.slice(3))) {
        if (!magick || !shots.includes(`native-${name}`)) continue;
        execFileSync(magick, [resolve(out, `rn-${name}.png`), resolve(out, `native-${name}.png`), '+append', resolve(out, `pair-${name}.png`)]);
    }
    console.log(magick ? `pairs written (RN left, native right) with ${magick}` : 'no ImageMagick: rn-* and native-* are the pairs');
    console.log(`Parity screens in ${out}`);
} catch (error) {
    evidenced(error);
    console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
    process.exitCode = error instanceof Stopped ? 3 : 1;
} finally {
    try { if (installed()) sh(`pm uninstall ${PKG}`); } catch { /* device gone */ }
    try { sh(`cmd uimode night ${['yes', 'no', 'auto'].includes(originalNight) ? originalNight : 'auto'}`); } catch { /* device gone */ }
    for (const [name, value] of [['user_rotation', originalRotation], ['accelerometer_rotation', originalAccelerometer]]) {
        try { sh(value === 'null' ? `settings delete system ${name}` : `settings put system ${name} ${value}`); } catch { /* device gone */ }
    }
    try { sh('rm -f /data/local/tmp/mindwtr-parity-ui.xml /data/local/tmp/mindwtr-parity.db'); } catch { /* device gone */ }
}
