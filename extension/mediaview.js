import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Drawer, Icon, button, label} from './ui.js';
import {Spring, ms, swap} from './motion.js';

/** An image that cross-fades when it changes. Stacked layers mean the old one is never blanked. */
export class ArtView {
    constructor(style_class, {fallback = null, ...props} = {}) {
        this.actor = new St.Widget({style_class, clip_to_allocation: true, layout_manager: new Clutter.BinLayout(), ...props});
        this._fallback = fallback;
        if (fallback) this.actor.add_child(fallback);
        this._layers = [];
        this._path = null;
        this._radius = style_class;
    }

    set(path) {
        if (path === this._path) return;
        this._path = path;
        const old = this._layers.pop();
        if (old) old.ease({opacity: 0, duration: ms(420), mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => old.destroy()});
        if (this._fallback) this._fallback.visible = !path;
        if (!path) return;
        const layer = new St.Widget({
            style_class: `${this._radius} art`, x_expand: true, y_expand: true, opacity: 0,
            style: `background-image: url("file://${path}"); background-size: cover; background-position: center;`,
        });
        this.actor.add_child(layer);
        this._layers.push(layer);
        layer.ease({opacity: 255, duration: ms(420), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
}

/** Thin progress line with a generous invisible hit area. Click or drag anywhere to seek. */
export class SeekBar {
    constructor(onSeek) {
        this._onSeek = onSeek;
        this.actor = new St.Widget({style_class: 'cae-seek', height: 22, x_expand: true, reactive: true, track_hover: true, layout_manager: new Clutter.FixedLayout()});
        this._track = new St.Widget({style_class: 'cae-progress', y: 8, height: 6});
        this._fill = new St.Widget({style_class: 'cae-progress-fill', y: 8, height: 6, width: 6});
        this._knob = new St.Widget({style_class: 'cae-seek-knob', y: 3, width: 16, height: 16, opacity: 0});
        for (const a of [this._track, this._fill, this._knob]) this.actor.add_child(a);
        this._v = 0;
        this.actor.connect('notify::allocation', () => this._place());
        this.actor.connect('notify::hover', () => this._knob.ease({
            opacity: this.actor.hover || this._drag ? 255 : 0, duration: ms(160), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }));
        this.actor.connect('button-press-event', (a, e) => { this._drag = true; this._point(e); return Clutter.EVENT_STOP; });
        this.actor.connect('motion-event', (a, e) => { if (this._drag) this._point(e); return Clutter.EVENT_PROPAGATE; });
        this.actor.connect('button-release-event', (a, e) => {
            if (this._drag) { this._drag = false; this._point(e, true); }
            return Clutter.EVENT_STOP;
        });
    }

    _point(e, commit = false) {
        const [ex, ey] = e.get_coords();
        const [ok, x] = this.actor.transform_stage_point(ex, ey);
        if (!ok) return;
        const W = this.actor.get_allocation_box().get_width();
        this._v = Math.max(0, Math.min(1, x / Math.max(1, W)));
        this._place();
        if (commit) this._onSeek(this._v);
    }

    set(v) {
        if (this._drag) return;
        this._v = v;
        this._place();
    }

    /** Also recolours for the current album art. */
    setAccent(hex) {
        const s = hex ? `background-color: ${hex};` : '';
        this._fill.style = s;
        this._knob.style = s;
    }

    _place() {
        if (!this.actor.has_allocation()) return;
        const W = this.actor.get_allocation_box().get_width();
        this._track.width = W;
        this._fill.width = Math.max(6, W * this._v);
        this._knob.x = Math.max(0, Math.min(W - 16, W * this._v - 8));
    }
}

const DIST_OPACITY = [255, 135, 85, 60];
const HOLD_AFTER_SCROLL = 4;

/**
 * Lyrics that follow the song: the current line sits in the middle at full strength and the rest
 * fall away with distance. Wheel to read ahead (it returns by itself); click a line to jump there.
 */
export class LyricsView {
    constructor(media, width, height) {
        this.media = media;
        this._w = width;
        // Fixed, because the view has no real height while its tab is hidden.
        this._h = height;
        this.actor = new St.Widget({style_class: 'cae-lyrics', x_expand: true, y_expand: true, clip_to_allocation: true, reactive: true, layout_manager: new Clutter.FixedLayout()});
        this._inner = new St.BoxLayout({style_class: 'cae-lyrics-inner', orientation: Clutter.Orientation.VERTICAL, width});
        this.actor.add_child(this._inner);
        this._scroll = new Spring(this._inner, y => { this._inner.translation_y = y; }, {response: .55, damping: 1, span: 200});
        this._rows = [];
        this._cur = -2;
        this._key = null;
        this.actor.connect('scroll-event', (a, e) => this._wheel(e));
        // Rows can only be measured once on stage, and the song moved on while the tab was hidden,
        // so settle on the current line just before the first frame that shows it.
        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped) return;
            global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (this.actor.mapped) this.tick(true, true);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _wheel(e) {
        const d = e.get_scroll_direction();
        let dy = 0;
        if (d === Clutter.ScrollDirection.UP) dy = 60;
        else if (d === Clutter.ScrollDirection.DOWN) dy = -60;
        else if (d === Clutter.ScrollDirection.SMOOTH) dy = -e.get_scroll_delta()[1] * 40;
        if (!dy) return Clutter.EVENT_PROPAGATE;
        this._holdUntil = GLib.get_monotonic_time() / 1e6 + HOLD_AFTER_SCROLL;
        const min = Math.min(0, this._h / 2 - this._inner.height);
        this._scroll.to(Math.max(min, Math.min(this._h / 2, this._scroll.target + dy)), {response: .28});
        return Clutter.EVENT_STOP;
    }

    /** Rebuilds only when the song or its lyrics changed. */
    sync() {
        const m = this.media;
        const key = `${m.track?.title}|${m.lyricsState}|${m.lyrics.length}|${m.plainLyrics?.length ?? 0}`;
        if (key !== this._key) {
            this._key = key;
            swap(this.actor, () => this._build(), {out: 110, back: 300});
            return;
        }
        this.tick();
    }

    _build() {
        const m = this.media;
        this._inner.destroy_all_children();
        this._rows = [];
        this._cur = -2;
        this._holdUntil = 0;
        const words = {
            idle: 'Play something to see its lyrics.', searching: 'Looking for lyrics…', none: 'No synced lyrics found for this track.',
            off: 'Lyrics are turned off in config.json.', offline: 'Could not reach the lyrics services. Retrying…',
            long: 'This is too long to be a song, so no lyrics were looked up.',
        }[m.lyricsState];
        if (m.lyrics.length) {
            m.lyrics.forEach((l, i) => {
                const lab = label(l.text || '♪', 'cae-lyric', {width: this._w - 24});
                lab.clutter_text.set({line_wrap: true, ellipsize: 0});
                const b = new St.Button({style_class: 'cae-lyric-btn', child: lab, x_align: Clutter.ActorAlign.START, opacity: DIST_OPACITY[3]});
                b.set_pivot_point(0, .5);
                b.connect('clicked', () => m.seekTo(l.t));
                this._inner.add_child(b);
                this._rows.push(b);
            });
        } else if (m.plainLyrics) {
            const lab = label(m.plainLyrics, 'cae-lyric plain', {width: this._w - 24});
            lab.clutter_text.set({line_wrap: true, ellipsize: 0});
            this._inner.add_child(lab);
        } else {
            const msg = label(words ?? '', 'cae-lyrics-msg', {width: this._w - 24});
            msg.clutter_text.set({line_wrap: true, ellipsize: 0});
            this._inner.add_child(msg);
        }
        this._scroll.set(m.lyrics.length ? this._h / 2 : 24);
        this.tick(true);
    }

    tick(force = false, snap = false) {
        if (!this._rows.length) return;
        const i = this.media.lineIndex;
        if (i === this._cur && !force) return;
        this._cur = i;
        const dur = ms(320);
        this._rows.forEach((r, n) => {
            const dist = Math.min(DIST_OPACITY.length - 1, Math.abs(n - i));
            const on = n === i;
            r.ease({opacity: i < 0 ? DIST_OPACITY[Math.min(3, n + 1)] : DIST_OPACITY[dist], scale_x: on ? 1.05 : 1, scale_y: on ? 1.05 : 1,
                duration: dur, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        if (GLib.get_monotonic_time() / 1e6 < (this._holdUntil ?? 0)) return;
        // Summed from preferred heights: allocation boxes do not exist until after a layout pass,
        // which the first tick of a new song precedes.
        let y = 0;
        const at = Math.max(0, i);
        for (let n = 0; n < at; n++) y += this._rows[n].get_preferred_height(this._w)[1];
        y += this._rows[at].get_preferred_height(this._w)[1] / 2;
        if (snap) this._scroll.set(this._h / 2 - y);
        else this._scroll.to(this._h / 2 - y);
    }

    destroy() { this._scroll.destroy(); }
}

/**
 * One line of the song, hanging from the top border over whatever is on screen. Never takes input.
 *
 * Power: nothing here polls. It wakes once per lyric line, timed to the line's start, and re-plans
 * when the player changes, seeks or pauses. It steps aside whenever a window reaches up under it
 * (maximized, full screen, tiled, or just dragged to the top), and learns that from window events.
 */
export class LyricPill {
    constructor(shell, media) {
        this.shell = shell;
        this.media = media;
        this.enabled = false;
        this.pinned = false;
        // Reactive only for the pin: hovering shows it, a click (or a right-click anywhere) pins/unpins.
        this.content = new St.BoxLayout({style_class: 'cae-lyric-pill', y_align: Clutter.ActorAlign.CENTER,
            reactive: true, track_hover: true});
        this._art = new ArtView('cae-lyric-pill-art', {y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._text = label('', 'cae-lyric-pill-text', {y_align: Clutter.ActorAlign.CENTER});
        this._text.clutter_text.ellipsize = 3;
        this.content.add_child(this._art.actor);
        this.content.add_child(this._text);
        this._pinIcon = new Icon('push_pin', 16, {y_align: Clutter.ActorAlign.CENTER});
        this._pin = button(this._pinIcon, 'cae-lyric-pin', () => this._togglePin(), {y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.content.add_child(this._pin);
        this.content.connect('notify::hover', () => this._syncPin());
        this.content.connect('button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_SECONDARY) return Clutter.EVENT_PROPAGATE;
            this._togglePin();
            return Clutter.EVENT_STOP;
        });
        this.drawer = new Drawer(shell, 'top', this.content, {modal: false, passive: true});
        this._line = '';
        this._timer = 0;
        this._coverCheck = 0;
        this.covered = false;

        media.connectObject('changed', () => this.update(), 'position', () => this.update(), this);
        this._watchWindows();
    }

    setEnabled(on) {
        this.enabled = on;
        this.update();
    }

    /** Pinned lines ignore windows reaching under them; unpinned ones step aside. */
    setPinned(on) {
        this.pinned = on;
        this._syncPin();
        this.update();
    }

    /** Through the dashboard, so its pin button and config.json agree. */
    _togglePin() {
        const d = this.shell.dashboard;
        if (d?.setLyricPillPinned) d.setLyricPillPinned(!this.pinned);
        else this.setPinned(!this.pinned);
    }

    /** The pin shows on hover, and stays (filled) while pinned so the state is visible. */
    _syncPin() {
        const show = this.content.hover || this.pinned;
        this._pinIcon.setIcon('push_pin', this.pinned);
        this._pin[this.pinned ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        if (this._pin.visible === show) return;
        this._pin.visible = show;
        if (this.drawer?.isOpen) this.drawer.relayout();
    }

    /** Old name, still called by the dashboard. */
    tick() { this.update(); }

    /** Show the current line (or hide), then sleep until the next line is due. */
    update() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
        const m = this.media;
        const i = m.lineIndex;
        const line = i >= 0 ? m.lyrics[i]?.text ?? '' : '';
        const dash = this.shell.dashboard?.drawer.isOpen;
        const live = this.enabled && m.playing && !!m.lyrics.length;
        // Pinned: stay over maximized and tiled windows too (full screen still hides it, via chrome).
        const show = live && !dash && !!line && (this.pinned || !this.covered);
        this._render(show, line);
        // Keep the schedule even while hidden by a window, so the right line is ready when it leaves.
        if (!live) return;
        const next = m.lyrics[i + 1];
        if (!next) return;
        const wait = Math.max(30, Math.round((next.t - 0.15 - m.position) * 1000));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timer = 0;
            this.update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render(show, line) {
        if (!show) {
            this.drawer.close();
            return;
        }
        const art = this.media.track?.art ?? null;
        this._art.set(art);
        this._art.actor.visible = !!art;
        if (!this.drawer.isOpen) {
            this._line = line;
            this._text.text = line;
            this.drawer.open({quiet: true});
            return;
        }
        if (line === this._line) return;
        this._line = line;
        swap(this._text, () => {
            this._text.text = line;
            this.drawer.relayout();
        }, {out: 100, back: 260});
    }

    // ---- stepping aside for windows ----

    _watchWindows() {
        const queue = () => this._queueCover();
        const watch = w => {
            if (!w || w._caePill) return;
            w._caePill = true;
            w.connectObject('position-changed', queue, 'size-changed', queue, 'notify::minimized', queue,
                'notify::fullscreen', queue, 'workspace-changed', queue,
                'unmanaged', () => { w._caePill = false; w.disconnectObject(this); queue(); }, this);
        };
        for (const a of global.get_window_actors()) watch(a.meta_window);
        global.display.connectObject('window-created', (d, w) => { watch(w); queue(); },
            'in-fullscreen-changed', queue, 'workareas-changed', queue, this);
        global.workspace_manager.connectObject('active-workspace-changed', queue, this);
        this._watched = () => global.get_window_actors().map(a => a.meta_window);
        this._queueCover();
    }

    _queueCover() {
        // Dragging fires position-changed every frame; look once per burst instead.
        if (this._coverCheck) return;
        this._coverCheck = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._coverCheck = 0;
            const c = this._isCovered();
            if (c !== this.covered) {
                this.covered = c;
                this.update();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Is any visible window under the strip where the line hangs (top centre of the main screen)? */
    _isCovered() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return false;
        const ws = global.workspace_manager.get_active_workspace();
        const area = ws.get_work_area_for_monitor(mon.index);
        const half = 400, cx = mon.x + mon.width / 2, bottom = area.y + 56;
        for (const w of ws.list_windows()) {
            if (w.minimized || w.get_monitor() !== mon.index || !w.showing_on_its_workspace()) continue;
            const t = w.get_window_type();
            if (t !== Meta.WindowType.NORMAL && t !== Meta.WindowType.DIALOG && t !== Meta.WindowType.MODAL_DIALOG) continue;
            if (w.is_fullscreen()) return true;
            const r = w.get_frame_rect();
            if (r.y < bottom && r.x < cx + half && r.x + r.width > cx - half) return true;
        }
        return false;
    }

    destroy() {
        if (this._timer) GLib.source_remove(this._timer);
        if (this._coverCheck) GLib.source_remove(this._coverCheck);
        this._timer = this._coverCheck = 0;
        this.media.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const w of this._watched?.() ?? []) { if (w._caePill) { w._caePill = false; w.disconnectObject(this); } }
        this.drawer.destroy();
    }
}
