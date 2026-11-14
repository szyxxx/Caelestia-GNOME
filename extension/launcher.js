import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {Drawer, Icon, hbox, label, vbox} from './ui.js';
import {Spring} from './motion.js';
import {readText} from './util.js';

const ITEM_H = 57;
const MAX_ITEMS = 7;
const MAX_FILES = 3;
const ROW_GAP = 2;
const CLIP_KEEP = 30;
const WALL_DIRS = ['.local/share/backgrounds', 'Pictures/Wallpapers'];

function score(name, q) {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 3;
    if (n.includes(` ${q}`)) return 2;
    if (n.includes(q)) return 1;
    let i = 0;
    for (const ch of n) if (ch === q[i]) i++;
    return i === q.length ? 0.5 : 0;
}

/** Arithmetic only: the regex admits digits and operators, so nothing else reaches Function. */
function calc(expr) {
    const e = expr.replace(/\^/g, '**').trim();
    if (!e || !/^[0-9+\-*/().% ]+$/.test(e)) return null;
    try {
        const v = new Function(`"use strict"; return (${e});`)();
        return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : null;
    } catch { return null; }
}

/**
 * Recent copied text, in memory only: it is gone at logout and never written to disk. Anything an
 * app marks as a password (the hint KeePassXC and others set) is skipped.
 */
class ClipHistory {
    constructor() {
        this.items = [];
        global.display.get_selection().connectObject('owner-changed', (s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD) this._read();
        }, this);
    }

    _read() {
        const clip = St.Clipboard.get_default();
        const mimes = clip.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (mimes.some(m => /password/i.test(m))) return;
        clip.get_text(St.ClipboardType.CLIPBOARD, (c, text) => {
            if (!text?.trim()) return;
            this.items = [text, ...this.items.filter(t => t !== text)].slice(0, CLIP_KEEP);
        });
    }

    destroy() { global.display.get_selection().disconnectObject(this); }
}

export class Launcher {
    constructor(shell) {
        this.shell = shell;
        this.clips = new ClipHistory();
        this.content = vbox('cae-launcher', {width: 632});
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        // One highlight slides between rows, where a per-row background would blink on and off.
        // y_expand is required: without it BinLayout ignores y_align and centres the highlight.
        this._hl = new St.Widget({style_class: 'cae-launcher-hl', height: ITEM_H, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.START, opacity: 0});
        this._hlY = new Spring(this._hl, y => { this._hl.translation_y = y; }, {response: .26, damping: 1, span: 100});
        this._list = vbox('cae-launcher-list', {x_expand: true});
        stack.add_child(this._hl);
        stack.add_child(this._list);
        this.content.add_child(stack);
        const search = hbox('cae-search');
        search.add_child(new Icon('search', 20, {style_class: 'cae-dim'}));
        this.entry = new St.Entry({style_class: 'cae-search-entry', hint_text: 'Search apps and files, or type ">" for commands', can_focus: true, x_expand: true});
        search.add_child(this.entry);
        this.content.add_child(search);
        this.entry.clutter_text.connect('text-changed', () => { this._queueFileSearch(); this._refresh(); });
        this.entry.clutter_text.connect('key-press-event', (a, e) => this._key(e));
        this.entry.clutter_text.connect('activate', () => this._run());

        this.drawer = new Drawer(shell, 'bottom', this.content);
        this.drawer.onOpen = () => { this.entry.text = ''; this._refresh(); };
        this.drawer.onFocus = () => this.entry.grab_key_focus();
    }

    open() { this.drawer.open(); }
    toggle() { this.drawer.toggle(); }
    close() { this.drawer.close(); }

    _key(e) {
        const k = e.get_key_symbol();
        if (k === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
        if (k === Clutter.KEY_Down || k === Clutter.KEY_Tab) { this._select(this._sel + 1); return Clutter.EVENT_STOP; }
        if (k === Clutter.KEY_Up || k === Clutter.KEY_ISO_Left_Tab) { this._select(this._sel - 1); return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }

    _actions() {
        const sys = SystemActions.getDefault();
        const scheme = [`${GLib.get_home_dir()}/.local/bin/caelestia-scheme`];
        return [
            {name: 'Wallpaper', desc: 'Pick a wallpaper and recolour the desktop', icon: 'wallpaper', keep: true, run: () => { this.entry.text = '>wall '; }},
            {name: 'Themes', desc: 'Rice profiles, colours, motion and shape', icon: 'palette', run: () => this.shell.dashboard.openTab(3)},
            {name: 'Clipboard', desc: 'Recently copied text (cleared at logout)', icon: 'content_paste', keep: true, run: () => { this.entry.text = '>clip '; }},
            {name: 'Lyrics on desktop', desc: 'Show the current line at the top of the screen', icon: 'subtitles', run: () => this.shell.dashboard.setLyricPill(!this.shell.dashboard.lyricPill.enabled)},
            {name: 'Pin lyrics on top', desc: 'Keep the desktop lyric line visible over maximized windows (toggle)', icon: 'push_pin', run: () => this.shell.dashboard.setLyricPillPinned(!this.shell.dashboard.lyricPill.pinned)},
            {name: 'Phone Link hotspot', desc: 'Turn the laptop hotspot for your phone on or off', icon: 'wifi_tethering', run: () => this.shell.phoneLink?.toggle()},
            {name: 'Refresh colours', desc: 'Regenerate the scheme from the wallpaper', icon: 'palette', run: () => this._spawn(scheme)},
            {name: 'Overview', desc: 'Show windows and workspaces', icon: 'grid_view', run: () => this.shell.showOverview()},
            {name: 'Settings', desc: 'Open GNOME Settings', icon: 'settings', run: () => Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate()},
            {name: 'Screenshot', desc: 'Open the screenshot tool', icon: 'screenshot_region', run: () => sys.activateScreenshotUI()},
            {name: 'Lock', desc: 'Lock the screen', icon: 'lock', run: () => sys.activateLockScreen()},
            {name: 'Suspend', desc: 'Suspend the computer', icon: 'bedtime', run: () => sys.activateSuspend()},
            {name: 'Log out', desc: 'End this session', icon: 'logout', run: () => sys.activateLogout()},
            {name: 'Restart', desc: 'Restart the computer', icon: 'cached', run: () => sys.activateRestart()},
            {name: 'Shut down', desc: 'Power off the computer', icon: 'power_settings_new', run: () => sys.activatePowerOff()},
        ];
    }

    _spawn(argv) {
        try { Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE); } catch (e) { Main.notifyError('Caelestia', e.message); }
    }

    _wallpapers(q) {
        const out = [];
        for (const rel of WALL_DIRS) {
            const dir = GLib.build_filenamev([GLib.get_home_dir(), rel]);
            let en;
            try { en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::content-type', 0, null); } catch { continue; }
            for (let i; (i = en.next_file(null));) {
                if (!i.get_content_type()?.startsWith('image/')) continue;
                const name = i.get_name();
                if (q && !score(name, q)) continue;
                const path = GLib.build_filenamev([dir, name]);
                out.push({name, desc: rel, icon: 'image', path, run: () => this.shell.setWallpaper(path)});
            }
            en.close(null);
        }
        return out;
    }

    _themes(q) {
        let c = null;
        try { c = JSON.parse(readText(`${GLib.get_user_data_dir()}/caelestia-rice/themes.json`) ?? 'null'); } catch {}
        if (!c) return [];
        const profile = c.profiles.map(p => ({name: p.name, desc: `Rice profile: ${p.motion}, ${p.corners}`, icon: 'auto_awesome', run: () => this.shell.applyTheme(['--profile', p.id])}));
        const palette = c.palettes.map(p => ({name: p.name, desc: 'Colours only', icon: 'palette', run: () => this.shell.applyTheme(['--palette', p.id])}));
        return [...profile, ...palette].filter(x => !q || score(x.name, q));
    }

    _clips(q) {
        return this.clips.items.filter(t => !q || t.toLowerCase().includes(q)).map(t => ({
            name: t.replace(/\s+/g, ' ').slice(0, 80), desc: `${t.length} characters`, icon: 'content_paste',
            run: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, t),
        }));
    }

    _items(text) {
        const t = text.trim();
        if (t.startsWith('>wall')) return this._wallpapers(t.slice(5).trim().toLowerCase());
        if (t.startsWith('>theme') || t.startsWith('>scheme')) return this._themes(t.replace(/^>\S+/, '').trim().toLowerCase());
        if (t.startsWith('>clip')) return this._clips(t.slice(5).trim().toLowerCase());
        if (t.startsWith('>')) {
            const q = t.slice(1).trim().toLowerCase();
            return this._actions().filter(a => !q || score(a.name, q));
        }
        const res = calc(t.startsWith('=') ? t.slice(1) : /[+\-*/%^]/.test(t) ? t : '');
        const items = [];
        if (res !== null)
            items.push({name: res, desc: 'Press Enter to copy', icon: 'calculate', run: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, res)});
        const sys = Shell.AppSystem.get_default();
        if (!t) {
            const used = Shell.AppUsage.get_default().get_most_used();
            const rest = sys.get_installed().filter(a => a.should_show()).map(a => sys.lookup_app(a.get_id())).filter(Boolean)
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));
            const seen = new Set();
            return [...used, ...rest].filter(a => a && !seen.has(a.get_id()) && seen.add(a.get_id())).slice(0, MAX_ITEMS).map(a => this._appItem(a));
        }
        const q = t.toLowerCase();
        const hits = sys.get_installed().filter(a => a.should_show())
            .map(a => [Math.max(score(a.get_name() ?? '', q), (a.get_keywords?.() ?? []).some(k => k.toLowerCase().startsWith(q)) ? 1 : 0, score(a.get_description?.() ?? '', q) >= 1 ? .4 : 0), a])
            .filter(x => x[0] > 0).sort((x, y) => y[0] - x[0]).slice(0, MAX_ITEMS);
        for (const [, a] of hits) {
            const app = sys.lookup_app(a.get_id());
            if (app) items.push(this._appItem(app));
        }
        return items;
    }

    _appItem(app) {
        return {
            name: app.get_name(), desc: app.get_description() ?? '', app,
            run: () => {
                app.activate();
                Main.overview.hide();
            },
        };
    }

    /** Spotlight-style file hits. Runs after typing pauses and never blocks the shell. */
    _queueFileSearch() {
        if (this._fileTimer) GLib.source_remove(this._fileTimer);
        this._fileTimer = 0;
        this._fileCancel?.cancel();
        this._files = [];
        const q = this.entry.text.trim();
        if (q.length < 2 || /^[>=]/.test(q)) return;
        this._fileTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._fileTimer = 0;
            this._searchFiles(q);
            return GLib.SOURCE_REMOVE;
        });
    }

    _searchFiles(q) {
        const cancel = this._fileCancel = new Gio.Cancellable();
        let proc;
        try {
            // `--` stops a query like "-a" being read as a flag.
            proc = Gio.Subprocess.new(['localsearch', 'search', '-l', '30', '-f', '--', ...q.split(/\s+/)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch { return; } // no indexer: app search still works
        proc.communicate_utf8_async(null, cancel, (p, res) => {
            let out;
            try { [, out] = p.communicate_utf8_finish(res); } catch { return; }
            if (cancel.is_cancelled() || this._gone || q !== this.entry.text.trim()) return;
            this._files = this._fileItems(out ?? '', q);
            if (this._files.length) this._refresh(Math.max(this._sel, 0));
        });
    }

    _fileItems(out, q) {
        const home = GLib.get_home_dir();
        const terms = q.toLowerCase().split(/\s+/);
        const hits = [];
        for (const line of out.split('\n')) {
            const uri = line.trim();
            if (!uri.startsWith('file://')) continue;
            let path;
            try { [path] = GLib.filename_from_uri(uri); } catch { continue; }
            const name = GLib.path_get_basename(path);
            const inName = terms.every(t => name.toLowerCase().includes(t));
            hits.push({inName, name, path, uri});
        }
        // Files named after the query first, then the ones closest to the top of the tree.
        hits.sort((a, b) => b.inName - a.inName || a.path.length - b.path.length);
        return hits.slice(0, MAX_FILES).map(h => ({
            name: h.name,
            desc: h.path.startsWith(`${home}/`) ? `~${h.path.slice(home.length)}` : h.path,
            icon: 'description',
            run: () => {
                try { Gio.AppInfo.launch_default_for_uri(h.uri, global.create_app_launch_context(0, -1)); }
                catch (e) { Main.notifyError('Caelestia', e.message); }
            },
        }));
    }

    _refresh(keepSel = 0) {
        const files = this._files ?? [];
        this._items_ = [...this._items(this.entry.text).slice(0, MAX_ITEMS - files.length), ...files];
        this._list.destroy_all_children();
        if (!this._items_.length)
            this._list.add_child(label('No results', 'cae-launcher-empty', {x_align: Clutter.ActorAlign.CENTER}));
        this._rows = this._items_.map((it, i) => {
            const row = new St.Button({style_class: 'cae-launcher-item', height: ITEM_H, x_expand: true, can_focus: false});
            const box = hbox('cae-launcher-row', {x_expand: true});
            box.add_child(it.app ? it.app.create_icon_texture(38) : new Icon(it.icon, 26, {style_class: 'cae-primary', width: 38}));
            const txt = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            txt.add_child(label(it.name, 'cae-launcher-name'));
            if (it.desc) txt.add_child(label(it.desc, 'cae-launcher-desc'));
            box.add_child(txt);
            row.child = box;
            row.connect('clicked', () => { this._sel = i; this._run(); });
            // Only a pointer that actually moves selects. A list redrawn under a resting pointer
            // must leave the top result selected, or Enter would open whatever sits beneath it.
            row.connect('motion-event', () => {
                if (this._sel !== i) this._select(i);
                return Clutter.EVENT_PROPAGATE;
            });
            this._list.add_child(row);
            return row;
        });
        this._sel = -1;
        this._select(keepSel);
        this._hl.opacity = this._rows.length ? 255 : 0;
        this.drawer.relayout();
    }

    _select(i) {
        const n = this._rows?.length ?? 0;
        if (!n) return;
        const first = this._sel < 0;
        this._sel = (i + n) % n;
        const y = this._sel * (ITEM_H + ROW_GAP);
        if (first && this._hlY.target === y) return;
        if (this.drawer?.isOpen) this._hlY.to(y);
        else this._hlY.set(y);
    }

    _run() {
        const it = this._items_?.[this._sel];
        if (!it) return;
        if (!it.keep) this.close();
        it.run();
    }

    destroy() {
        this._gone = true;
        this._hlY.destroy();
        this.clips.destroy();
        if (this._fileTimer) GLib.source_remove(this._fileTimer);
        this._fileCancel?.cancel();
        this.drawer.destroy();
    }
}
