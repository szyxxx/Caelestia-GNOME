import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
import {Frame} from './frame.js';
import {Launcher} from './launcher.js';
import {Dashboard} from './dashboard.js';
import {Osd, Session, Sidebar} from './sidebar.js';
import {Popouts} from './popouts.js';
import {Services} from './services.js';
import {WindowMotion} from './windowmotion.js';
import {Phone} from './phone.js';
import {PhoneLink} from './hotspot.js';
import {ShareShelf} from './shareshelf.js';
import {BORDER, setTokens} from './ui.js';
import {frameLog, ms, setMotion} from './motion.js';
import {CACHE, dropSession, loadConfig, readText} from './util.js';

const DATA = GLib.build_filenamev([GLib.get_user_data_dir(), 'caelestia-rice']);
const FALLBACK = {surface: '#111318', primary: '#9ccbfb', secondary: '#b9c8da', tertiary: '#d3bfe6', surfaceContainer: '#1d2024', surfaceContainerHigh: '#272a2f'};

export default class CaelestiaGnome extends Extension {
    enable() {
        this.theme = {colors: {...FALLBACK}};
        this._loadScheme();
        this._freshenCss();
        const config = loadConfig();
        frameLog.enabled = !!config.debugMotion;
        if (frameLog.enabled) {
            this._frameDump = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                if (frameLog.samples.length) {
                    GLib.mkdir_with_parents(CACHE, 0o755);
                    GLib.file_set_contents(`${CACHE}/motion-frames.json`, JSON.stringify(frameLog.samples));
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._hidePanel();
        this.services = new Services();
        this.phone = new Phone();
        this.phoneLink = new PhoneLink(this.services, this.phone);
        this.shareShelf = new ShareShelf(this.path, this.phone);
        this.drawers = [];

        // Order matters: Frame's widgets call into the panels, and panels must stack above it.
        this.frame = new Frame(this);
        this.launcher = new Launcher(this);
        this.dashboard = new Dashboard(this, config, this.path);
        this.sidebar = new Sidebar(this);
        this.session = new Session(this);
        this.osd = new Osd(this);
        this.popouts = new Popouts(this);
        this.drawers = [this.launcher, this.dashboard, this.sidebar, this.session, this.popouts].map(p => p.drawer);
        this.windowMotion = new WindowMotion();

        // Super opens the launcher; the real overview stays reachable from the bar logo.
        this._overviewToggle = Main.overview.toggle;
        Main.overview.toggle = () => {
            if (Main.overview.visible) Main.overview.hide();
            else this.launcher.toggle();
        };

        this._bannerAlign = Main.messageTray.bannerAlignment;
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        // Keep banners inside the frame instead of over the border.
        Main.messageTray.translation_x = -BORDER;
        Main.messageTray.translation_y = BORDER;

        this._settings = this.getSettings();
        const bind = (key, fn) => Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, fn);
        bind('toggle-launcher', () => this.launcher.toggle());
        bind('toggle-dashboard', () => this.dashboard.toggle());
        bind('toggle-sidebar', () => this.sidebar.toggle());
        bind('toggle-session', () => this.session.toggle());

        this._monitor = Gio.File.new_for_path(`${DATA}/scheme.json`).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => this._schemeChanged());
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._bg.connectObject('changed::picture-uri-dark', () => this._regen(), this);
    }

    /**
     * shell.css is compiled from theme.tpl.css by caelestia-scheme, which normally runs only when the
     * look changes. Without this, an updated extension runs its new code on the old styles.
     */
    _freshenCss() {
        const mtime = path => {
            try {
                return Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time().to_unix();
            } catch { return 0; }
        };
        if (mtime(`${this.path}/theme.tpl.css`) <= mtime(`${DATA}/shell.css`)) return;
        try {
            // It rewrites scheme.json, which the monitor picks up to reload the styles.
            Gio.Subprocess.new([`${GLib.get_home_dir()}/.local/bin/caelestia-scheme`], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) { console.warn(`caelestia-gnome: could not compile the stylesheet: ${e.message}`); }
    }

    _loadScheme() {
        try {
            const s = JSON.parse(readText(`${DATA}/scheme.json`) ?? '{}');
            Object.assign(this.theme.colors, s.colors);
            setMotion(s.tokens?.motion ?? 'fluid');
            const key = `${s.tokens?.border}/${s.tokens?.rounding}`;
            this._tokensChanged = this._tokenKey !== undefined && key !== this._tokenKey;
            this._tokenKey = key;
            setTokens(s.tokens ?? {});
        } catch (e) { console.warn(`caelestia-gnome scheme: ${e.message}`); }
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const file = Gio.File.new_for_path(`${DATA}/shell.css`);
        if (this._css) theme.unload_stylesheet(this._css);
        this._css = null;
        if (file.query_exists(null)) {
            theme.load_stylesheet(file);
            this._css = file;
        }
    }

    _schemeChanged() {
        if (this._reload) return;
        this._reload = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            this._reload = 0;
            this._loadScheme();
            if (this._tokensChanged) {
                Main.messageTray.translation_x = -BORDER;
                Main.messageTray.translation_y = BORDER;
                this.frame.rebuild();
            }
            this.frame.repaint();
            for (const d of [...this.drawers, this.osd.drawer, this.dashboard.lyricPill.drawer]) d.repaint();
            this.dashboard.drawer.relayout();
            this.dashboard.themes.refresh();
            this._endFade();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Freezes the current picture over the screen, so a theme change dissolves in instead of
     * every colour flipping on the same frame. The picture is a GPU copy, so this costs one frame.
     */
    async _beginFade() {
        if (this._fade || !ms(1)) return;
        try {
            const [content] = await new Shell.Screenshot().screenshot_stage_to_content();
            const a = new St.Widget({content, width: global.stage.width, height: global.stage.height, reactive: false});
            Main.uiGroup.add_child(a);
            this._fade = a;
            // Should a change produce no new scheme, the screen must never stay frozen.
            this._fadeGuard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
                this._fadeGuard = 0;
                this._endFade();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) { console.debug(`caelestia-gnome fade: ${e.message}`); }
    }

    _endFade() {
        if (this._fadeGuard) GLib.source_remove(this._fadeGuard);
        this._fadeGuard = 0;
        const a = this._fade;
        this._fade = null;
        a?.ease({opacity: 0, duration: 420, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => a.destroy()});
    }

    /** Runs caelestia-scheme with these arguments and shows the result. */
    async applyTheme(args) {
        const quiet = !args.length || ['--save', '--delete'].includes(args[0]);
        if (!quiet) await this._beginFade();
        try {
            const proc = Gio.Subprocess.new([`${GLib.get_home_dir()}/.local/bin/caelestia-scheme`, ...args], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, (p, res) => {
                try { p.wait_finish(res); } catch {}
                if (!this.dashboard) return;
                this.dashboard.themes.refresh();
                if (!p.get_successful()) this._endFade();
            });
        } catch (e) {
            console.warn(e);
            this._endFade();
        }
    }

    _regen() {
        try { Gio.Subprocess.new([`${GLib.get_home_dir()}/.local/bin/caelestia-scheme`], Gio.SubprocessFlags.NONE); } catch (e) { console.warn(e); }
    }

    setWallpaper(path) {
        const uri = Gio.File.new_for_path(path).get_uri();
        this._bg.set_string('picture-uri', uri);
        this._bg.set_string('picture-uri-dark', uri);
        new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'}).set_string('picture-uri', uri);
    }

    /** Wires a bar item to its popout. The popout is built after the bar, hence the late lookup. */
    hoverPopout(actor, key) {
        actor.connect('notify::hover', () => {
            if (actor.hover) this.popouts?.hover(key, actor);
            else this.popouts?.leave();
        });
    }

    anyModalOpen() {
        return this.drawers.some(d => d.isOpen && d.modal);
    }

    closeDrawers(except) {
        for (const d of this.drawers)
            if (d !== except) d.close();
    }

    showOverview() {
        this.closeDrawers();
        Main.overview.show();
    }

    openSettings() {
        Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop')?.activate();
    }

    _hidePanel() {
        const box = Main.layoutManager.panelBox;
        Main.layoutManager.removeChrome(box);
        box.hide();
        Main.layoutManager.uiGroup.add_child(box);
    }

    _showPanel() {
        const box = Main.layoutManager.panelBox;
        Main.layoutManager.uiGroup.remove_child(box);
        Main.layoutManager.addChrome(box, {affectsStruts: true, trackFullscreen: true});
        box.show();
        Main.layoutManager.uiGroup.set_child_below_sibling(box, Main.layoutManager.modalDialogGroup);
    }

    disable() {
        for (const k of ['toggle-launcher', 'toggle-dashboard', 'toggle-sidebar', 'toggle-session']) Main.wm.removeKeybinding(k);
        if (this._reload) GLib.source_remove(this._reload);
        this._reload = 0;
        if (this._frameDump) GLib.source_remove(this._frameDump);
        this._frameDump = 0;
        frameLog.enabled = false;
        if (this._fadeGuard) GLib.source_remove(this._fadeGuard);
        this._fadeGuard = 0;
        this._fade?.destroy();
        this._fade = null;
        this._monitor.cancel();
        this._bg.disconnectObject(this);
        Main.overview.toggle = this._overviewToggle;
        Main.messageTray.bannerAlignment = this._bannerAlign;
        Main.messageTray.translation_x = Main.messageTray.translation_y = 0;
        this.windowMotion?.destroy();
        this.windowMotion = null;
        for (const p of [this.popouts, this.osd, this.session, this.sidebar, this.dashboard, this.launcher, this.frame]) p.destroy();
        this.services.destroy();
        this.shareShelf?.destroy();
        this.shareShelf = null;
        this.phoneLink?.destroy();
        this.phoneLink = null;
        this.phone?.destroy();
        this.phone = null;
        this._showPanel();
        dropSession();
        if (this._css) St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._css);
        this._css = null;
        this.popouts = this.osd = this.session = this.sidebar = this.dashboard = this.launcher = this.frame = null;
        this.services = this.theme = this._settings = this._monitor = this._bg = null;
        this.drawers = [];
    }
}
