import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {Drawer, Icon, Slider, button, hbox, iconButton, label, vbox} from './ui.js';

function ago(dt) {
    if (!dt) return '';
    const s = GLib.DateTime.new_now_local().difference(dt) / 1e6;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

/** Notification list, sliders and quick toggles: Caelestia's sidebar and utilities in one drawer. */
export class Sidebar {
    constructor(shell) {
        this.shell = shell;
        this.content = vbox('cae-sidebar', {width: 430});

        const head = hbox('cae-side-head');
        this._count = label('Notifications', 'cae-side-title', {x_expand: true});
        head.add_child(this._count);
        head.add_child(iconButton('clear_all', 22, 'cae-flat', () => this._clear()));
        this.content.add_child(head);

        this._scroll = new St.ScrollView({style_class: 'cae-side-scroll', y_expand: true, x_expand: true, hscrollbar_policy: St.PolicyType.NEVER});
        this._list = vbox('cae-notif-list', {x_expand: true});
        this._scroll.child = this._list;
        this.content.add_child(this._scroll);

        const util = vbox('cae-card cae-utilities');
        this._vol = new Slider('volume_up');
        this._bri = new Slider('light_mode');
        const s = shell.services;
        this._vol.connect('changed', (a, v) => { s.volume = v; });
        this._bri.connect('changed', (a, v) => { s.brightness = v; });
        util.add_child(this._vol);
        util.add_child(this._bri);
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 8, row_spacing: 8}), x_expand: true});
        const G = grid.layout_manager;
        this._toggles = [
            ['wifi', () => s.net.wifi, () => { s.wifi = !s.net.wifi; }],
            ['bluetooth', () => s.btOn, () => { s.btOn = !s.btOn; }],
            ['mic', () => !s.micMuted, () => s.toggleMic()],
            ['airplanemode_active', () => s.airplane, () => { s.airplane = !s.airplane; }],
            ['notifications_off', () => s.dnd, () => { s.dnd = !s.dnd; }],
            ['nightlight', () => s.nightLight, () => { s.nightLight = !s.nightLight; }],
            ['coffee', () => s.idleInhibited, () => s.toggleIdleInhibit()],
            ['speed', () => s.profile === 'performance', () => s.cycleProfile()],
        ].map(([ic, get, set], i) => {
            const b = iconButton(ic, 22, 'cae-toggle', () => set(), {iconProps: {fill: true}, button: {x_expand: true}});
            G.attach(b, i % 4, Math.floor(i / 4), 1, 1);
            return {b, get};
        });
        util.add_child(grid);
        const foot = hbox('cae-side-foot');
        foot.add_child(iconButton('lock', 22, 'cae-toggle', () => { this.drawer.close(); SystemActions.getDefault().activateLockScreen(); }, {button: {x_expand: true}}));
        foot.add_child(iconButton('settings', 22, 'cae-toggle', () => { this.drawer.close(); shell.openSettings(); }, {button: {x_expand: true}}));
        foot.add_child(iconButton('screenshot_region', 22, 'cae-toggle', () => { this.drawer.close(); SystemActions.getDefault().activateScreenshotUI(); }, {button: {x_expand: true}}));
        util.add_child(foot);
        this.content.add_child(util);

        this.drawer = new Drawer(shell, 'right', this.content, {full: true});
        this.drawer.onOpen = () => { this._rebuild(); this._sync(); };
        this.drawer.staggerParts = () => [head, this._scroll, ...util.get_children()];
        s.connectObject('changed', () => this._sync(), this);
        const tray = Main.messageTray;
        tray.connectObject('source-added', (t, src) => this._track(src), 'source-removed', () => this._queue(), this);
        tray.getSources().forEach(src => this._track(src));
    }

    toggle() { this.drawer.toggle(); }
    close() { this.drawer.close(); }

    _track(src) {
        src.connectObject('notification-added', (o, n) => {
            n.connectObject('destroy', () => this._queue(), this);
            this._queue();
        }, 'notification-removed', () => this._queue(), this);
        src.notifications?.forEach(n => n.connectObject('destroy', () => this._queue(), this));
    }

    _queue() {
        if (!this.drawer.isOpen || this._pending) return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _all() {
        return Main.messageTray.getSources().flatMap(s => s.notifications)
            .sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0));
    }

    _rebuild() {
        this._list.destroy_all_children();
        const all = this._all();
        this._count.text = all.length ? `${all.length} notification${all.length > 1 ? 's' : ''}` : 'Notifications';
        if (!all.length) {
            const e = vbox('cae-notif-empty', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, y_expand: true});
            e.add_child(new Icon('notifications_paused', 54, {style_class: 'cae-dim'}));
            e.add_child(label('All caught up', 'cae-dim', {x_align: Clutter.ActorAlign.CENTER}));
            this._list.add_child(e);
            return;
        }
        for (const n of all) this._list.add_child(this._row(n));
    }

    _row(n) {
        const row = hbox('cae-notif-row', {x_expand: true});
        const gicon = n.gicon ?? n.source?.icon;
        row.add_child(gicon ? new St.Icon({gicon, icon_size: 36, y_align: Clutter.ActorAlign.START}) : new Icon('notifications', 28, {style_class: 'cae-primary'}));
        const t = vbox('', {x_expand: true});
        const top = hbox('');
        const title = label(n.title ?? n.source?.title ?? '', 'cae-notif-title', {x_expand: true});
        title.clutter_text.ellipsize = 3;
        top.add_child(title);
        top.add_child(label(ago(n.datetime), 'cae-notif-time'));
        t.add_child(top);
        if (n.body) {
            const b = label(n.body, 'cae-notif-body');
            b.clutter_text.set({line_wrap: true, ellipsize: 0});
            t.add_child(b);
        }
        row.add_child(t);
        row.add_child(iconButton('close', 18, 'cae-flat', () => n.destroy()));
        return button(row, 'cae-notif', () => { this.drawer.close(); n.activate(); }, {x_expand: true});
    }

    _clear() {
        for (const n of this._all())
            if (!n.resident) n.destroy();
        this._rebuild();
    }

    _sync() {
        const s = this.shell.services;
        this._vol.setValue(s.volume);
        this._vol.icon.setIcon(s.volumeIcon, true);
        this._bri.visible = s.brightness !== null;
        this._bri.setValue(s.brightness ?? 0);
        for (const {b, get} of this._toggles) {
            if (get()) b.add_style_pseudo_class('checked');
            else b.remove_style_pseudo_class('checked');
        }
    }

    destroy() {
        if (this._pending) GLib.source_remove(this._pending);
        this.shell.services.disconnectObject(this);
        const tray = Main.messageTray;
        tray.disconnectObject(this);
        for (const src of tray.getSources()) {
            src.notifications?.forEach(n => n.disconnectObject(this));
            src.disconnectObject(this);
        }
        this.drawer.destroy();
    }
}

/** Replaces the centre OSD with Caelestia's pair of vertical bars on the right edge. */
export class Osd {
    constructor(shell) {
        this.shell = shell;
        this.content = hbox('cae-osd');
        this._vol = new Slider('volume_up', {vertical: true});
        this._bri = new Slider('light_mode', {vertical: true});
        const s = shell.services;
        this._vol.connect('changed', (a, v) => { s.volume = v; this.show(); });
        this._bri.connect('changed', (a, v) => { s.brightness = v; this.show(); });
        this.content.add_child(this._vol);
        this.content.add_child(this._bri);
        this.drawer = new Drawer(shell, 'right', this.content, {modal: false});
        s.connectObject('changed', () => this._sync(), this);

        const mgr = Main.osdWindowManager;
        this._orig = mgr.show;
        mgr.show = (icon, label_, levels) => {
            const name = icon?.to_string?.() ?? '';
            if (/audio|microphone|brightness/.test(name)) this.show();
            else this._orig.call(mgr, icon, label_, levels);
        };
    }

    _sync() {
        const s = this.shell.services;
        this._vol.setValue(s.volume);
        this._vol.icon.setIcon(s.volumeIcon, true);
        this._bri.visible = s.brightness !== null;
        this._bri.setValue(s.brightness ?? 0);
    }

    show() {
        this._sync();
        // Both sit on the right edge, and the sidebar already has these sliders.
        if (this.shell.session.drawer.isOpen || this.shell.sidebar.drawer.isOpen) return;
        // Quiet: a normal open would close whichever panel the user is working in.
        if (!this.drawer.isOpen) this.drawer.open({quiet: true});
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._timer = 0;
            if (this._vol.hover || this._bri.hover) return GLib.SOURCE_CONTINUE;
            this.drawer.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timer) GLib.source_remove(this._timer);
        Main.osdWindowManager.show = this._orig;
        this.shell.services.disconnectObject(this);
        this.drawer.destroy();
    }
}

/**
 * The power menu: grows out of the bar beside its power button, as a labelled list.
 * Lock comes first and has focus, so Enter right after opening is the harmless choice;
 * Restart, Shut down and Log out sit below a divider and still get GNOME's own confirmation.
 */
export class Session {
    constructor(shell) {
        this.shell = shell;
        this.content = vbox('cae-session');
        const sys = SystemActions.getDefault();
        const act = fn => () => { this.drawer.close(); fn(); };
        const groups = [
            [
                ['lock', 'Lock', 'primary', () => sys.canLockScreen, act(() => sys.activateLockScreen())],
                ['bedtime', 'Sleep', '', () => sys.canSuspend, act(() => sys.activateSuspend())],
            ],
            [
                ['restart_alt', 'Restart…', '', () => sys.canRestart, act(() => sys.activateRestart())],
                ['power_settings_new', 'Shut down…', 'danger', () => sys.canPowerOff, act(() => sys.activatePowerOff())],
                ['logout', 'Log out…', '', () => sys.canLogout, act(() => sys.activateLogout())],
            ],
        ];
        this._btns = [];
        this._rows = [];
        this._seps = [];
        groups.forEach((g, gi) => {
            if (gi) {
                const sep = new St.Widget({style_class: 'cae-session-sep', x_expand: true});
                this.content.add_child(sep);
                this._seps.push({sep, group: gi});
            }
            for (const [ic, text, kind, can, fn] of g) {
                const row = hbox('cae-session-row-inner', {x_expand: true});
                row.add_child(new Icon(ic, 22, {fill: kind === 'primary'}));
                row.add_child(label(text, 'cae-session-label', {x_expand: true}));
                const b = button(row, `cae-session-row ${kind}`, fn, {x_expand: true});
                b.connect('key-press-event', (a, e) => this._key(e));
                this.content.add_child(b);
                this._rows.push({b, can, group: gi});
            }
        });
        this.drawer = new Drawer(shell, 'left', this.content);
        this.drawer.onFocus = () => this._btns[0]?.grab_key_focus();
    }

    /** Hide what this machine or session cannot do (no suspend, no lock in some sessions). */
    _sync() {
        for (const {b, can} of this._rows) b.visible = !!can();
        this._btns = this._rows.filter(r => r.b.visible).map(r => r.b);
        // A divider only separates two groups that both have something in them.
        const shown = gi => this._rows.some(r => r.group === gi && r.b.visible);
        for (const {sep, group} of this._seps) sep.visible = shown(group) && shown(group - 1);
    }

    _key(e) {
        const k = e.get_key_symbol();
        const n = this._btns.length;
        const i = this._btns.findIndex(b => b.has_key_focus());
        if (k === Clutter.KEY_Down) this._btns[(i + 1) % n].grab_key_focus();
        else if (k === Clutter.KEY_Up) this._btns[(i + n - 1) % n].grab_key_focus();
        else if (k === Clutter.KEY_Escape) this.drawer.close();
        else return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this.drawer.isOpen) {
            this.drawer.close();
            return;
        }
        this._sync();
        // Grow from the power button (clamped to the screen by the drawer).
        const p = this.shell.frame?.bar?.powerButton;
        if (p) {
            const [, y] = p.get_transformed_position();
            const [, h] = p.get_transformed_size();
            this.drawer.setAnchor(y + h / 2);
        }
        this.drawer.open();
    }

    close() { this.drawer.close(); }
    destroy() { this.drawer.destroy(); }
}
