import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BAR_INNER, BAR_WIDTH, BORDER, Corner, Icon, ROUNDING, button, every, label, vbox} from './ui.js';
import {Spring, ms, reduced, swap} from './motion.js';

const WS_COUNT = 5;
const WS_SIZE = 30;

class Workspaces {
    constructor(shell) {
        this.shell = shell;
        this.actor = new St.Widget({
            style_class: 'cae-pill', width: BAR_INNER, height: WS_COUNT * WS_SIZE + 10,
            reactive: true, layout_manager: new Clutter.FixedLayout(),
        });
        const pos = i => 5 + i * WS_SIZE;
        // One pill per occupied workspace plus a bridge to the next; fading these is what lets
        // neighbours melt together, where rebuilding them on every restack made them flicker.
        this._occ = [];
        this._bridges = [];
        for (let i = 0; i < WS_COUNT; i++) {
            const o = new St.Widget({style_class: 'cae-ws-occupied', x: 5, y: pos(i), width: WS_SIZE, height: WS_SIZE, opacity: 0});
            this._occ.push(o);
            this.actor.add_child(o);
            if (i === WS_COUNT - 1) continue;
            const b = new St.Widget({style_class: 'cae-ws-bridge', x: 5, y: pos(i) + WS_SIZE / 2, width: WS_SIZE, height: WS_SIZE, opacity: 0});
            this._bridges.push(b);
            this.actor.add_child(b);
        }
        this._active = new St.Widget({style_class: 'cae-ws-active', x: 5, width: WS_SIZE, height: WS_SIZE});
        this.actor.add_child(this._active);
        this._head = new Spring(this._active, () => this._placeActive(), {span: 100});
        this._tail = new Spring(this._active, () => this._placeActive(), {span: 100});
        this._labels = [];
        for (let i = 0; i < WS_COUNT; i++) {
            const n = i;
            const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
            const base = label(String(i + 1), 'cae-ws-label', {x_align: Clutter.ActorAlign.CENTER, x_expand: true});
            const on = label(String(i + 1), 'cae-ws-label active', {x_align: Clutter.ActorAlign.CENTER, x_expand: true, opacity: 0});
            box.add_child(base);
            box.add_child(on);
            this._labels.push({base, on});
            this.actor.add_child(button(box, 'cae-ws-button', () => this._go(n), {
                x: 5, y: pos(i), width: WS_SIZE, height: WS_SIZE,
            }));
        }
        this.actor.connect('scroll-event', (a, e) => {
            const d = e.get_scroll_direction();
            const cur = global.workspace_manager.get_active_workspace_index();
            if (d === Clutter.ScrollDirection.UP) this._go(cur - 1);
            else if (d === Clutter.ScrollDirection.DOWN) this._go(cur + 1);
            return Clutter.EVENT_STOP;
        });
        const wm = global.workspace_manager;
        wm.connectObject('active-workspace-changed', () => this._syncActive(true),
            'workspace-added', () => this._syncOccupied(), 'workspace-removed', () => this._syncOccupied(), this);
        global.display.connectObject('window-created', () => this._later(), 'restacked', () => this._later(), this);
        global.window_manager.connectObject('destroy', () => this._later(), this);
        this._syncActive(false);
        this._syncOccupied(false);
    }

    _go(i) {
        const wm = global.workspace_manager;
        if (i >= 0 && i < wm.n_workspaces)
            wm.get_workspace_by_index(i).activate(global.get_current_time());
    }

    _later() {
        if (this._pending) return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._syncOccupied();
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeActive() {
        this._active.y = this._head.value;
        this._active.height = Math.max(WS_SIZE, this._tail.value - this._head.value);
    }

    /** The edge in front runs ahead and the one behind catches up, so the pill stretches as it travels. */
    _syncActive(animate) {
        const i = global.workspace_manager.get_active_workspace_index();
        const top = 5 + i * WS_SIZE, bottom = top + WS_SIZE;
        const down = top > this._head.target;
        if (animate && !reduced()) {
            this._head.to(top, {response: down ? .46 : .24, damping: 1});
            this._tail.to(bottom, {response: down ? .24 : .46, damping: 1});
        } else {
            this._head.set(top);
            this._tail.set(bottom);
        }
        this._labels.forEach(({on}, n) => {
            const v = n === i ? 255 : 0;
            if (animate) on.ease({opacity: v, duration: ms(240), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else on.opacity = v;
        });
    }

    /** Only ever changes what the windows changed; this runs on every restack. */
    _syncOccupied(animate = true) {
        const wm = global.workspace_manager;
        const used = [];
        for (let i = 0; i < WS_COUNT; i++) {
            const ws = i < wm.n_workspaces ? wm.get_workspace_by_index(i) : null;
            used.push(!!ws?.list_windows().some(w => !w.skip_taskbar && !w.is_on_all_workspaces()));
        }
        const set = (actor, on) => {
            const v = on ? 255 : 0;
            if (actor._want === v) return;
            actor._want = v;
            if (animate) actor.ease({opacity: v, duration: ms(280), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else actor.opacity = v;
        };
        used.forEach((u, i) => {
            set(this._occ[i], u);
            if (i < WS_COUNT - 1) set(this._bridges[i], u && used[i + 1]);
            if (u) this._labels[i].base.add_style_class_name('occupied');
            else this._labels[i].base.remove_style_class_name('occupied');
        });
    }

    destroy() {
        if (this._pending) GLib.source_remove(this._pending);
        this._head.destroy();
        this._tail.destroy();
        for (const o of [global.workspace_manager, global.display, global.window_manager])
            o.disconnectObject(this);
    }
}

/** App icon plus the focused window's title, written sideways along the bar. */
class ActiveWindow {
    constructor(shell, barHeight) {
        this.shell = shell;
        this._max = Math.max(120, Math.round(barHeight * 0.32));
        // Room left in the bar, set by Bar; the title never grows past it, so the power button stays on screen.
        this.room = () => Infinity;
        this.actor = vbox('cae-active-window', {
            x_align: Clutter.ActorAlign.CENTER, y_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true, track_hover: true,
        });
        this._icon = new St.Bin({x_align: Clutter.ActorAlign.CENTER});
        this._holder = new St.Widget({width: BAR_INNER, height: 1, layout_manager: new Clutter.FixedLayout()});
        this._title = new St.Label({style_class: 'cae-active-title'});
        this._title.clutter_text.ellipsize = 3;
        this._title.rotation_angle_z = 90;
        this._holder.add_child(this._title);
        this.actor.add_child(this._icon);
        this.actor.add_child(this._holder);
        // The bar's layout follows this height, so a new title glides the pill rather than jolting it.
        this._len = new Spring(this._holder, h => { this._holder.height = Math.max(1, h); }, {response: .36, damping: 1, span: 200});
        global.display.connectObject('notify::focus-window', () => this._sync(), this);
        // Measuring needs a stage: the bar is parented right after this constructor.
        this._holder.connectObject('notify::mapped', () => { this._watch(); this._render(false); }, this);
        shell.hoverPopout(this.actor, 'window');
    }

    _watch() {
        // The share shelf takes focus for a moment during a drop; the bar keeps showing the real window.
        const f = global.display.focus_window;
        if (f?.get_gtk_application_id?.() === 'dev.caelestia.ShareShelf' && this._win) return;
        this._win?.disconnectObject(this);
        const w = this._win = f;
        w?.connectObject('notify::title', () => this._render(true), this);
    }

    _sync() {
        this._watch();
        swap(this.actor, () => this._render(false), {out: 80, back: 220});
    }

    _render(glide) {
        if (!this._holder.mapped) return;
        const w = this._win;
        const app = w ? Shell.WindowTracker.get_default().get_window_app(w) : null;
        if (!glide) this._icon.child = app ? app.create_icon_texture(22) : new Icon('desktop_windows', 20, {style_class: 'cae-bar-dim'});
        this._title.text = w?.title || 'Desktop';
        // The last width would cap the natural one, so clear it first.
        this._title.set_width(-1);
        const [, natW] = this._title.get_preferred_width(-1);
        const [, natH] = this._title.get_preferred_height(-1);
        const len = Math.max(0, Math.min(natW, this._max, this.room()));
        this._title.set_width(len);
        this._title.set_position((BAR_INNER + natH) / 2, 0);
        this._len.to(len);
    }

    destroy() {
        this._len.destroy();
        global.display.disconnectObject(this);
        this._win?.disconnectObject(this);
    }
}

class Clock {
    constructor(shell) {
        this.actor = button(vbox('cae-clock-inner'), 'cae-pill cae-clock', () => shell.dashboard.toggle(), {track_hover: true});
        const box = this.actor.child;
        box.add_child(new Icon('calendar_month', 18, {style_class: 'cae-tertiary'}));
        this._h = label('', 'cae-clock-text', {x_align: Clutter.ActorAlign.CENTER});
        this._m = label('', 'cae-clock-text', {x_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._h);
        box.add_child(this._m);
        const put = (l, text) => { if (l.text !== text) swap(l, () => { l.text = text; }, {out: 120, back: 320}); };
        // Wake once a minute, on the minute (it used to wake every 5 s).
        const show = () => {
            const n = GLib.DateTime.new_now_local();
            put(this._h, n.format('%H'));
            put(this._m, n.format('%M'));
            return n;
        };
        const plan = () => {
            const n = show();
            const wait = Math.max(1, 60 - n.get_second()) * 1000 + 50;
            this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => { plan(); return GLib.SOURCE_REMOVE; });
        };
        plan();
        // Timers pause while suspended, so re-read the time right after waking.
        const replan = () => { if (this._tick) GLib.source_remove(this._tick); plan(); };
        this._sleepSub = Gio.DBus.system.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
            'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (c, sn, o, i, sig, params) => { if (!params.deepUnpack()[0]) replan(); });
        this._stop = () => {
            if (this._tick) GLib.source_remove(this._tick);
            this._tick = 0;
            Gio.DBus.system.signal_unsubscribe(this._sleepSub);
        };
        shell.hoverPopout(this.actor, 'clock');
    }

    destroy() { this._stop(); }
}

class Status {
    constructor(shell) {
        this.shell = shell;
        this.actor = button(vbox('cae-status-inner'), 'cae-pill cae-status', () => shell.sidebar.toggle());
        const box = this.actor.child;
        const hot = (ic, key) => {
            const i = new Icon(ic, 18, {reactive: true, track_hover: true});
            shell.hoverPopout(i, key);
            box.add_child(i);
            return i;
        };
        this._vol = hot('volume_up', 'audio');
        this._net = hot('wifi', 'network');
        this._bt = hot('bluetooth', 'bluetooth');
        this._phone = hot('smartphone', 'phone');
        this._batt = hot('battery_full', 'battery');
        shell.services.connectObject('changed', () => this._sync(), this);
        shell.phone?.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const s = this.shell.services;
        this._vol.setIcon(s.volumeIcon, true);
        this._net.setIcon(s.net.icon, true);
        this._bt.visible = s.btAvailable;
        this._bt.setIcon(s.btOn ? 'bluetooth' : 'bluetooth_disabled', true);
        // The phone shows once one is paired; dimmed while it is out of reach.
        // Before any phone is paired it still shows (as "set up"), so pairing is one hover away.
        const ph = this.shell.phone, d = ph?.device;
        this._phone.visible = !!d || !!ph?.available;
        this._phone.setIcon(d ? (d.connected ? 'smartphone' : 'phonelink_off') : 'phonelink_setup', !!d?.connected);
        this._phone.opacity = d?.connected ? 255 : 140;
        const b = s.batteryIcon;
        this._batt.visible = !!b;
        if (b) this._batt.setIcon(b, true);
    }

    destroy() {
        this.shell.services.disconnectObject(this);
        this.shell.phone?.disconnectObject(this);
    }
}

/**
 * Hosts AppIndicator items in the bar. ubuntu-appindicators adds them to the (hidden) top panel;
 * their containers are moved here and handed back when the extension is disabled.
 */
class Tray {
    constructor() {
        this.actor = vbox('cae-pill cae-tray', {visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._moved = new Map();
        Main.panel._rightBox.connectObject('child-added', () => this._adopt(), this);
        this._adopt();
    }

    _adopt() {
        for (const [key, item] of Object.entries(Main.panel.statusArea)) {
            // ubuntu-appindicators keys items by "busName@objectPath".
            if (!key.includes('@') && !/StatusIcon/.test(item?.constructor?.name ?? '')) continue;
            const c = item?.container;
            if (!c || this._moved.has(c)) continue;
            const parent = c.get_parent();
            if (!parent) continue;
            parent.remove_child(c);
            this.actor.add_child(c);
            this._moved.set(c, item);
            if (item.menu?._boxPointer) item.menu._boxPointer._userArrowSide = St.Side.LEFT;
            c.connectObject('destroy', () => { this._moved.delete(c); this._sync(); }, this);
        }
        this._sync();
    }

    _sync() { this.actor.visible = this._moved.size > 0; }

    destroy() {
        Main.panel._rightBox.disconnectObject(this);
        for (const [c, item] of this._moved) {
            c.disconnectObject(this);
            this.actor.remove_child(c);
            Main.panel._rightBox.insert_child_at_index(c, 0);
            if (item.menu?._boxPointer) item.menu._boxPointer._userArrowSide = St.Side.TOP;
        }
        this._moved.clear();
    }
}

class Bar {
    constructor(shell, monitor) {
        this.shell = shell;
        this.actor = vbox('cae-bar', {
            x_expand: true, y_expand: true, width: BAR_WIDTH, height: monitor.height, reactive: true,
        });
        const logo = button(new Icon('deployed_code', 24, {fill: true}), 'cae-logo', () => shell.showOverview());
        this.workspaces = new Workspaces(shell);
        this.window = new ActiveWindow(shell, monitor.height);
        this.tray = new Tray();
        this.clock = new Clock(shell);
        this.status = new Status(shell);
        const power = button(new Icon('power_settings_new', 22, {style_class: 'cae-error'}), 'cae-power', () => shell.session.toggle());
        this.powerButton = power;
        for (const a of [logo, this.workspaces.actor, this.window.actor, this.tray.actor,
            this.clock.actor, this.status.actor, power])
            this.actor.add_child(a);
        this._others = [logo, this.workspaces.actor, this.tray.actor, this.clock.actor, this.status.actor, power];
        this.window.room = () => this._room();
        // A tray icon or status icon appearing shrinks the room, so refit the title after layout settles.
        this._lastRoom = null;
        const refit = () => {
            if (this._refit) return;
            this._refit = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refit = 0;
                const r = this._room();
                if (r !== this._lastRoom) { this._lastRoom = r; this.window._render(true); }
                return GLib.SOURCE_REMOVE;
            });
        };
        for (const a of this._others) a.connectObject('notify::height', refit, 'notify::visible', refit, this);
        // Wheel over empty bar space: volume on the top half, brightness on the bottom half.
        this.actor.connect('scroll-event', (a, e) => {
            const d = e.get_scroll_direction();
            const step = d === Clutter.ScrollDirection.UP ? .05 : d === Clutter.ScrollDirection.DOWN ? -.05 : 0;
            if (!step) return Clutter.EVENT_PROPAGATE;
            const [, y] = e.get_coords();
            const s = shell.services;
            if (y < monitor.y + monitor.height / 2) {
                s.volume = s.volume + step;
                shell.osd.show();
            } else if (s.brightness !== null) {
                s.brightness += step;
                shell.osd.show();
            }
            return Clutter.EVENT_STOP;
        });
    }

    /** Height the title may use: the bar minus padding, gaps, every other item and the window icon. */
    _room() {
        const node = this.actor.get_theme_node();
        const gap = node.get_length('spacing');
        const shown = this._others.filter(a => a.visible);
        let used = node.get_padding(St.Side.TOP) + node.get_padding(St.Side.BOTTOM) + gap * shown.length;
        for (const a of shown) used += a.get_preferred_height(BAR_WIDTH)[1];
        const win = this.window.actor;
        const icon = this.window._icon.get_preferred_height(BAR_INNER)[1];
        used += icon + win.get_theme_node().get_length('spacing') + win.get_theme_node().get_vertical_padding();
        // Keep a little slack so rounding never nudges the power button off the edge.
        return Math.floor(this.actor.height - used - 8);
    }

    destroy() {
        if (this._refit) GLib.source_remove(this._refit);
        for (const a of this._others) a.disconnectObject(this);
        for (const c of [this.workspaces, this.window, this.tray, this.clock, this.status]) c.destroy();
        this.actor.destroy();
    }
}

/**
 * The screen border. Solid strips reserve work-area space through struts, so windows sit
 * inside the frame; four corner pieces add the rounded inner edge. Nothing here covers the
 * middle of the screen, so input and direct scanout are unaffected.
 */
export class Frame {
    constructor(shell) {
        this.shell = shell;
        this.actors = [];
        this.bar = null;
        Main.layoutManager.connectObject('monitors-changed', () => this.rebuild(), this);
        this.rebuild();
    }

    _strip(x, y, w, h, opts = {}) {
        const a = new St.Widget({style_class: 'cae-strip', x, y, width: w, height: h, reactive: !!opts.hover});
        if (opts.hover) this._hover(a, opts.hover);
        Main.layoutManager.addChrome(a, {affectsStruts: !opts.noStrut, trackFullscreen: true});
        this.actors.push(a);
        return a;
    }

    /** Border hot zones: rest the pointer in the middle of an edge to open that edge's drawer. */
    _hover(actor, fn) {
        actor.connect('enter-event', () => {
            this._clearDwell();
            this._dwell = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._dwell = 0;
                // Closing a panel replays pointer crossings; don't reopen under a resting pointer.
                const sinceClose = GLib.get_monotonic_time() - (this.shell.lastClose ?? 0);
                if (sinceClose > 1000000) fn();
                return GLib.SOURCE_REMOVE;
            });
        });
        actor.connect('leave-event', () => this._clearDwell());
    }

    _clearDwell() {
        if (this._dwell) GLib.source_remove(this._dwell);
        this._dwell = 0;
    }

    _corner(x, y, cx, cy) {
        const c = new Corner(this.shell.theme, cx, cy);
        c.set_position(x, y);
        Main.layoutManager.addChrome(c, {trackFullscreen: true});
        this.actors.push(c);
    }

    rebuild() {
        this.clear();
        const primary = Main.layoutManager.primaryMonitor;
        for (const m of Main.layoutManager.monitors) {
            const isP = m === primary;
            const left = isP ? BAR_WIDTH : BORDER;
            const R = ROUNDING;
            const leftStrip = this._strip(m.x, m.y, left, m.height);
            const midW = m.width - left - BORDER;
            const thirdX = m.x + left + midW * .35, thirdW = midW * .3;
            if (isP) {
                // The top and bottom strips are split so only their centres are hot zones.
                this._strip(m.x + left, m.y, thirdX - m.x - left, BORDER);
                this._strip(thirdX, m.y, thirdW, BORDER, {hover: () => this.shell.dashboard.drawer.open({transient: true})});
                this._strip(thirdX + thirdW, m.y, m.x + m.width - BORDER - thirdX - thirdW, BORDER);
                const by = m.y + m.height - BORDER;
                this._strip(m.x + left, by, thirdX - m.x - left, BORDER);
                this._strip(thirdX, by, thirdW, BORDER, {hover: () => this.shell.launcher.drawer.open({transient: true})});
                this._strip(thirdX + thirdW, by, m.x + m.width - BORDER - thirdX - thirdW, BORDER);
                this.bar = new Bar(this.shell, m);
                leftStrip.add_child(this.bar.actor);
            } else {
                this._strip(m.x + left, m.y, midW, BORDER);
                this._strip(m.x + left, m.y + m.height - BORDER, midW, BORDER);
            }
            this._strip(m.x + m.width - BORDER, m.y, BORDER, m.height);
            const lx = m.x + left, rx = m.x + m.width - BORDER - R;
            const ty = m.y + BORDER, by = m.y + m.height - BORDER - R;
            this._corner(lx, ty, 1, 1);
            this._corner(rx, ty, 0, 1);
            this._corner(lx, by, 1, 0);
            this._corner(rx, by, 0, 0);
        }
    }

    repaint() {
        for (const a of this.actors)
            if (a instanceof St.DrawingArea) a.queue_repaint();
    }

    clear() {
        this._clearDwell();
        this.bar?.destroy();
        this.bar = null;
        for (const a of this.actors) {
            Main.layoutManager.removeChrome(a);
            a.destroy();
        }
        this.actors = [];
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this.clear();
    }
}

