import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Drawer, Icon, Ring, button, every, hbox, iconButton, label, vbox} from './ui.js';
import {Media} from './media.js';
import {ArtView, LyricsView, LyricPill, SeekBar} from './mediaview.js';
import {enter, ms, swap} from './motion.js';
import {Stats, bytes} from './services.js';
import {ThemePage} from './themes.js';
import {fetchJson, fmtTime, saveConfig} from './util.js';
import {launchSettings} from './netpanels.js';

// WMO weather code -> [Material Symbol, description].
const WEATHER = [
    [[0], 'clear_day', 'Clear'], [[1, 2], 'partly_cloudy_day', 'Partly cloudy'], [[3], 'cloud', 'Overcast'],
    [[45, 48], 'foggy', 'Fog'], [[51, 53, 55, 56, 57], 'rainy_light', 'Drizzle'], [[61, 63, 65, 66, 67, 80, 81, 82], 'rainy', 'Rain'],
    [[71, 73, 75, 77, 85, 86], 'weather_snowy', 'Snow'], [[95, 96, 99], 'thunderstorm', 'Thunderstorm'],
];

function card(style = '', orient = vbox) {
    return orient(`cae-card ${style}`);
}

/**
 * Month grid plus the agenda of one day, fed by GNOME's calendar service. Connect a Google account in
 * Online Accounts and its events arrive here through Evolution Data Server, which keeps them in sync
 * in the background and raises reminders. Only reads while the dashboard is open.
 */
class Calendar {
    constructor() {
        this.actor = vbox('cae-cal', {x_expand: true});
        const head = hbox('cae-cal-head');
        this._title = label('', 'cae-cal-title', {x_expand: true});
        head.add_child(this._title);
        head.add_child(iconButton('add', 20, 'cae-flat', () => this._newEvent()));
        head.add_child(iconButton('chevron_left', 20, 'cae-flat', () => this._shift(-1)));
        head.add_child(iconButton('chevron_right', 20, 'cae-flat', () => this._shift(1)));
        this.actor.add_child(head);
        this._grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true}), x_expand: true});
        this.actor.add_child(this._grid);
        this._agendaHead = label('', 'cae-cal-agenda-head');
        this._agenda = vbox('cae-cal-agenda');
        // A fixed block: its contents change after the panel has measured itself.
        const lower = vbox('cae-cal-lower');
        const line = hbox('cae-cal-agenda-line', {x_expand: true});
        this._agendaHead.x_expand = true;
        this._agendaHead.clutter_text.ellipsize = 3;
        line.add_child(this._agendaHead);
        lower.add_child(line);
        lower.add_child(this._agenda);
        this._connect = button(label('Connect Google', 'cae-cal-connect-text'), 'cae-cal-connect',
            () => { this.onLeave?.(); launchSettings('online-accounts', 'add', 'google'); }, {y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this._connect);
        this.actor.add_child(lower);
        // Row and agenda sizes are fixed, so the panel keeps its size from month to month and day to day.
        this._offset = 0;
        this._cells = new Map();
        this._selected = null;   // day of the month in the shown month; null until opened
        this.google = null;      // null: unknown yet
        this.render();
    }

    /** The event source already running behind GNOME's (hidden) date menu; the server holds one range. */
    get _source() {
        const src = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (src && src !== this._watched) {
            this._watched?.disconnectObject(this);
            this._watched = src;
            src.connectObject('changed', () => this._queue(), 'notify::has-calendars', () => this._queue(), this);
        }
        return src;
    }

    /** Called when the dashboard opens. */
    opened() {
        this._open = true;
        this._checkGoogle();
        this.render();
        this._request();
        this._syncEvents();
    }

    closed() { this._open = false; }

    _queue() {
        if (!this._open || this._pending) return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._syncEvents();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Is a Google account connected, with its calendar turned on? */
    _checkGoogle() {
        Gio.DBus.session.call('org.gnome.OnlineAccounts', '/org/gnome/OnlineAccounts', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', null, null, Gio.DBusCallFlags.NONE, 3000, null, (c, r) => {
                let found = false;
                try {
                    const objs = c.call_finish(r).recursiveUnpack()[0];
                    found = Object.values(objs).some(o => {
                        const a = o['org.gnome.OnlineAccounts.Account'];
                        return a?.ProviderType === 'google' && !a.CalendarDisabled;
                    });
                } catch (e) { console.debug(`caelestia-gnome accounts: ${e.message}`); }
                this.google = found;
                this._syncEvents();
            });
    }

    _firstOfMonth() {
        const now = GLib.DateTime.new_now_local();
        return GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0).add_months(this._offset);
    }

    _request() {
        const first = this._firstOfMonth();
        // Two months, so the agenda still has something near the end of a month.
        this._source?.requestRange(new Date(first.to_unix() * 1000), new Date(first.add_months(2).to_unix() * 1000));
    }

    _shift(d) {
        this._offset += d;
        this._selected = this._offset === 0 ? GLib.DateTime.new_now_local().get_day_of_month() : 1;
        swap(this._grid, () => { this.render(); this._request(); this._syncEvents(); }, {out: 80, back: 200});
    }

    render() {
        const now = GLib.DateTime.new_now_local();
        this._selected ??= now.get_day_of_month();
        // Rebuilding about 40 labels during the first frame of a slide is what made it hitch.
        const key = `${now.format('%F')}|${this._offset}`;
        if (key === this._key) return;
        this._key = key;
        const lay = this._grid.layout_manager;
        this._grid.destroy_all_children();
        this._cells.clear();
        const first = this._firstOfMonth();
        this._title.text = first.format('%B %Y');
        ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].forEach((d, i) =>
            lay.attach(label(d, 'cae-cal-dow', {x_align: Clutter.ActorAlign.CENTER, x_expand: true}), i, 0, 1, 1));
        const lead = first.get_day_of_week() - 1;
        const days = first.add_months(1).add_days(-1).get_day_of_month();
        for (let d = 1; d <= days; d++) {
            const pos = lead + d - 1;
            const today = this._offset === 0 && d === now.get_day_of_month();
            const box = vbox('cae-cal-cell', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(label(String(d), `cae-cal-day${today ? ' today' : ''}`, {x_align: Clutter.ActorAlign.CENTER}));
            const dot = new St.Widget({style_class: 'cae-cal-dot', x_align: Clutter.ActorAlign.CENTER, opacity: 0});
            box.add_child(dot);
            const b = button(box, 'cae-cal-btn', () => { this._selected = d; this._syncEvents(); }, {x_align: Clutter.ActorAlign.CENTER});
            this._cells.set(d, {b, dot});
            lay.attach(b, pos % 7, 1 + Math.floor(pos / 7), 1, 1);
        }
        // Always six weeks tall: a stand-in on the last row holds the height in shorter months.
        if (lead + days <= 35) {
            const box = vbox('cae-cal-cell', {x_align: Clutter.ActorAlign.CENTER, opacity: 0});
            box.add_child(label('0', 'cae-cal-day'));
            box.add_child(new St.Widget({style_class: 'cae-cal-dot'}));
            lay.attach(new St.Bin({style_class: 'cae-cal-btn', child: box, x_align: Clutter.ActorAlign.CENTER}), 0, 6, 1, 1);
        }
    }

    _syncEvents() {
        const src = this._source;
        const first = this._firstOfMonth();
        const dateOf = d => new Date(first.get_year(), first.get_month() - 1, d);
        for (const [d, c] of this._cells) {
            c.dot.opacity = src?.hasEvents(dateOf(d)) ? 255 : 0;
            // Today is already highlighted; a second highlight around it reads as a smudge.
            const isNow = this._offset === 0 && d === GLib.DateTime.new_now_local().get_day_of_month();
            c.b[d === this._selected && !isNow ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        }
        this._connect.visible = this.google === false;
        const slots = 3;
        const sel = dateOf(this._selected ?? 1);
        const end = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() + 1);
        const now = GLib.DateTime.new_now_local();
        const isToday = this._offset === 0 && this._selected === now.get_day_of_month();
        const when = GLib.DateTime.new_local(sel.getFullYear(), sel.getMonth() + 1, sel.getDate(), 0, 0, 0);
        this._agendaHead.text = isToday ? 'Today' : when.format('%A, %-d %B');
        const events = src?.getEvents(sel, end) ?? [];
        this._agenda.destroy_all_children();
        if (!events.length) {
            this._agenda.add_child(label(src?.isLoading ? 'Loading…' : 'No events', 'cae-cal-none'));
            return;
        }
        for (const e of events.slice(0, slots)) {
            const row = hbox('cae-cal-event-inner', {x_expand: true});
            const allDay = e.date.getHours() === 0 && e.date.getMinutes() === 0 && e.end - e.date >= 86400000;
            const t = v => `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`;
            row.add_child(label(allDay ? 'All day' : t(e.date), 'cae-cal-event-time'));
            const name = label(e.summary || '(No title)', 'cae-cal-event-name', {x_expand: true});
            name.clutter_text.ellipsize = 3;
            row.add_child(name);
            this._agenda.add_child(button(row, 'cae-cal-event', () => this._openDay(sel), {x_expand: true}));
        }
        if (events.length > slots) this._agendaHead.text += `  ·  +${events.length - slots} more`;
    }

    _openDay(day) {
        this.onLeave?.();
        const uri = `https://calendar.google.com/calendar/r/day/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    _newEvent() {
        this.onLeave?.();
        const first = this._firstOfMonth();
        const d = new Date(first.get_year(), first.get_month() - 1, this._selected ?? 1);
        const ymd = v => `${v.getFullYear()}${String(v.getMonth() + 1).padStart(2, '0')}${String(v.getDate()).padStart(2, '0')}`;
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        Gio.AppInfo.launch_default_for_uri_async(`https://calendar.google.com/calendar/r/eventedit?dates=${ymd(d)}/${ymd(next)}`, null, null, null);
    }

    destroy() {
        if (this._pending) GLib.source_remove(this._pending);
        this._pending = 0;
        this._watched?.disconnectObject(this);
        this._watched = null;
    }
}

/** Name, percentage and a thin level line: readable at a glance, unlike an unlabelled slider. */
function meter(name) {
    const box = vbox('cae-meter', {x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const top = hbox('');
    top.add_child(label(name, 'cae-meter-name', {x_expand: true}));
    const value = label('', 'cae-meter-value');
    top.add_child(value);
    box.add_child(top);
    // A fixed width: the first reading comes before layout has finished, when a measured one is still 0.
    const TRACK = 216;
    const track = new St.Widget({style_class: 'cae-meter-track', width: TRACK, height: 5, layout_manager: new Clutter.FixedLayout()});
    const fill = new St.Widget({style_class: 'cae-meter-fill', height: 5, width: 5});
    track.add_child(fill);
    box.add_child(track);
    return {box, set: v => {
        value.text = `${Math.round(v * 100)}%`;
        fill.ease({width: Math.max(5, TRACK * v), duration: ms(500), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }};
}

export class Dashboard {
    constructor(shell, config, path) {
        this.shell = shell;
        this.config = config;
        this.stats = new Stats();
        this.media = new Media({...config, extensionPath: path});
        this.lyricPill = new LyricPill(shell, this.media);
        this.lyricPill.enabled = !!config.lyricPill;
        this.lyricPill.pinned = !!config.lyricPillPinned;
        this._page = 0;

        this.content = vbox('cae-dash');
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.themes = new ThemePage(shell);
        this._pages = [this._buildDash(), this._buildMedia(), this._buildPerf(), this.themes.actor];
        this._pages.forEach((p, i) => { p.visible = i === 0; this._stack.add_child(p); });
        this.content.add_child(this._stack);
        this.content.add_child(this._buildTabs());

        this.drawer = new Drawer(shell, 'top', this.content);
        this.drawer.onOpen = () => {
            this._cal.opened();
            this.stats.resetRates();
            this._tick();
            this._syncWatching();
            this._syncMedia();
            if (this._page === 3) this.themes.refresh();
            // Bar heights need a finished layout, which the first tick cannot have.
            this._settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._settle = 0;
                this._tick();
                return GLib.SOURCE_REMOVE;
            });
        };
        this.drawer.onClose = () => { this._cal.closed(); this._syncWatching(); };
        this.drawer.staggerParts = () => this._partsOf(this._page);
        this.media.connect('changed', () => this._syncMedia());
        this._stopWeather = every(1800, () => this._weather());
        this._syncMedia();
        this._syncWatching();
    }

    /** Timers exist only while something on screen needs them, so a closed panel costs no wakeups. */
    _syncTimers() {
        const open = this.drawer.isOpen;
        if (open && !this._statsTimer) {
            this._statsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { this._tick(); return GLib.SOURCE_CONTINUE; });
        } else if (!open && this._statsTimer) {
            GLib.source_remove(this._statsTimer);
            this._statsTimer = 0;
        }
        // Often enough that a lyric line lands on its beat.
        // Only the open lyrics page needs this; the desktop line schedules itself per lyric.
        const fast = this._showingLyrics() && this.media.playing;
        if (fast && !this._ticker) {
            this._ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => { this._fastTick(); return GLib.SOURCE_CONTINUE; });
        } else if (!fast && this._ticker) {
            GLib.source_remove(this._ticker);
            this._ticker = 0;
        }
    }

    _partsOf(page) {
        if (page === 0) return this._dashRoot.get_children().flatMap(c => (c.has_style_class_name('cae-grid-col') ? c.get_children() : [c]));
        if (page === 1) return this._mediaRow.get_children();
        if (page === 2) return this._pages[2].get_children();
        return this.themes.parts();
    }

    _showingLyrics() { return this.drawer.isOpen && this._page === 1; }

    _syncWatching() {
        this.media.watching = this.drawer.isOpen || this.lyricPill.enabled;
        this.media.precise = this.drawer.isOpen && this._page === 1;
        this._syncTimers();
        // The desktop line hides while the dashboard is open and comes back when it closes.
        this.lyricPill.update();
    }

    _fastTick() {
        if (this._showingLyrics()) {
            this._lyrics.tick();
            this._syncSeek();
        }
    }

    setLyricPill(on) {
        this.lyricPill.setEnabled(on);
        this._syncWatching();
        saveConfig({lyricPill: on});
        this._pillBtn?.[on ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        this._syncPinBtn();
    }

    setLyricPillPinned(on) {
        this.lyricPill.setPinned(on);
        saveConfig({lyricPillPinned: on});
        this._syncPinBtn();
    }

    /** The pin only means something while the desktop line is on. */
    _syncPinBtn() {
        const b = this._pinBtn;
        if (!b) return;
        b.visible = this.lyricPill.enabled;
        b[this.lyricPill.pinned ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
    }

    openTab(i) {
        if (!this.drawer.isOpen) {
            for (const [n, p] of this._pages.entries()) p.visible = n === i;
            this._tabs[this._page].remove_style_pseudo_class('checked');
            this._tabs[i].add_style_pseudo_class('checked');
            this._page = i;
            this.drawer.open();
            return;
        }
        this._show(i);
    }

    toggle() { this.drawer.toggle(); }
    open() { this.drawer.open(); }
    close() { this.drawer.close(); }

    _buildTabs() {
        const tabs = hbox('cae-tabs', {x_align: Clutter.ActorAlign.CENTER});
        this._tabs = [['dashboard', 'Dashboard'], ['queue_music', 'Media'], ['speed', 'Performance'], ['palette', 'Themes']].map(([ic, name], i) => {
            const box = vbox('cae-tab-inner', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new Icon(ic, 22));
            box.add_child(label(name, 'cae-tab-label', {x_align: Clutter.ActorAlign.CENTER}));
            const b = button(box, 'cae-tab', () => this._show(i));
            tabs.add_child(b);
            return b;
        });
        this._tabs[0].add_style_pseudo_class('checked');
        return tabs;
    }

    /**
     * Fade through: the old page goes, the panel glides to the new page's size, the new page's
     * parts arrive one after another. A second click mid-way simply takes over.
     */
    _show(i) {
        if (i === this._page && !this._pending) return;
        this._tabs[this._page].remove_style_pseudo_class('checked');
        this._tabs[i].add_style_pseudo_class('checked');
        const dir = i > this._page ? 1 : -1;
        this._page = i;
        this._pending = true;
        this._syncWatching();
        const next = this._pages[i];
        swap(this._stack, () => {
            for (const p of this._pages) p.visible = p === next;
            this._pending = false;
            if (i === 3) this.themes.refresh();
            this._tick();
            if (i === 1) this._lyrics.sync();
            this.drawer.relayout();
            this._partsOf(i).forEach((a, n) => enter(a, {delay: n * 22, duration: 380, dx: 14 * dir}));
        }, {out: 90, back: 120});
    }

    _buildDash() {
        const root = this._dashRoot = hbox('cae-grid');

        // Left: the moment (time, date, weather), then the machine.
        const left = vbox('cae-grid-col');
        left.width = 256;
        const now = card('cae-now', vbox);
        this._dT = label('', 'cae-now-time');
        this._dD = label('', 'cae-now-date');
        now.add_child(this._dT);
        now.add_child(this._dD);
        const w = hbox('cae-now-weather', {x_expand: true});
        this._wIcon = new Icon('cloud', 26, {fill: true, style_class: 'cae-primary'});
        const wt = vbox('', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._wTemp = label('--°', 'cae-weather-temp');
        this._wDesc = label(this.config.place, 'cae-weather-desc');
        this._wDesc.clutter_text.ellipsize = 3;
        wt.add_child(this._wTemp);
        wt.add_child(this._wDesc);
        w.add_child(this._wIcon);
        w.add_child(wt);
        now.add_child(w);

        const r = card('cae-system', vbox);
        r.y_expand = true;
        this._rCpu = meter('CPU');
        this._rMem = meter('Memory');
        this._rDisk = meter('Disk');
        for (const m of [this._rCpu, this._rMem, this._rDisk]) r.add_child(m.box);
        left.add_child(now);
        left.add_child(r);
        root.add_child(left);

        // Middle: the calendar and the selected day.
        const c = card('cae-cal-card', vbox);
        c.width = 348;
        this._cal = new Calendar();
        this._cal.onLeave = () => this.drawer.close();
        c.add_child(this._cal.actor);
        root.add_child(c);

        // Right: what is playing.
        const m = card('cae-media-card');
        m.width = 232;
        // y_expand false: otherwise the art layer's own expand flag spreads up and stretches this.
        const coverWrap = new St.Widget({width: 164, height: 164, y_expand: false, layout_manager: new Clutter.FixedLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring(this.shell.theme, 164, {thickness: 5});
        this._cover = new ArtView('cae-cover-round', {
            x: 12, y: 12, width: 140, height: 140,
            fallback: new Icon('music_note', 46, {fill: true, style_class: 'cae-dim', x_expand: true, y_expand: true}),
        });
        coverWrap.add_child(this._ring);
        coverWrap.add_child(this._cover.actor);
        m.add_child(coverWrap);
        this._mTitle = this._ell('cae-media-title');
        this._mAlbum = this._ell('cae-media-album');
        this._mArtist = this._ell('cae-media-artist');
        // The text takes whatever height is left, centred, so the controls always sit at the foot.
        const text = vbox('cae-media-text', {x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        for (const l of [this._mTitle, this._mAlbum, this._mArtist]) text.add_child(l);
        m.add_child(text);
        const ctl = this._controls();
        this._mPlay = ctl.play;
        m.add_child(ctl.box);
        root.add_child(m);
        return root;
    }

    _ell(style) {
        const l = label('', style, {x_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.ellipsize = 3;
        return l;
    }

    _controls() {
        const box = hbox('cae-media-ctl', {x_align: Clutter.ActorAlign.CENTER});
        const play = new Icon('play_arrow', 28, {fill: true});
        box.add_child(iconButton('skip_previous', 26, 'cae-flat', () => this.media.command('Previous'), {iconProps: {fill: true}}));
        box.add_child(button(play, 'cae-play', () => this.media.command('PlayPause')));
        box.add_child(iconButton('skip_next', 26, 'cae-flat', () => this.media.command('Next'), {iconProps: {fill: true}}));
        return {box, play};
    }

    _buildMedia() {
        const page = new St.Widget({style_class: 'cae-media-page', layout_manager: new Clutter.BinLayout(), width: 1060, height: 340, clip_to_allocation: true});
        this._backdrop = new ArtView('cae-media-backdrop', {x_expand: true, y_expand: true, opacity: 150});
        page.add_child(this._backdrop.actor);
        page.add_child(new St.Widget({style_class: 'cae-media-scrim', x_expand: true, y_expand: true}));
        const row = this._mediaRow = hbox('cae-media-row', {x_expand: true, y_expand: true});
        this._bigCover = new ArtView('cae-cover-big', {
            width: 280, height: 280, y_align: Clutter.ActorAlign.CENTER,
            fallback: new Icon('music_note', 72, {fill: true, style_class: 'cae-dim', x_expand: true, y_expand: true}),
        });
        row.add_child(this._bigCover.actor);

        const col = vbox('cae-media-big', {y_align: Clutter.ActorAlign.CENTER, width: 320});
        const ell = (t, s) => { const l = label(t, s); l.clutter_text.ellipsize = 3; return l; };
        this._bSource = button(ell('', 'cae-media-source'), 'cae-source', () => this.media.nextPlayer(), {x_align: Clutter.ActorAlign.START});
        this._bTitle = ell('Nothing playing', 'cae-media-big-title');
        this._bArtist = ell('', 'cae-media-big-artist');
        this._bAlbum = ell('', 'cae-media-album');
        this._seek = new SeekBar(v => this.media.seekTo(v * (this.media.track?.length ?? 0)));
        const times = hbox('cae-media-times');
        this._bPos = label('0:00', 'cae-media-pos', {x_expand: true});
        this._bLen = label('0:00', 'cae-media-pos');
        times.add_child(this._bPos);
        times.add_child(this._bLen);
        for (const a of [this._bSource, this._bTitle, this._bArtist, this._bAlbum, this._seek.actor, times]) col.add_child(a);
        const ctl = this._controls();
        this._bPlay = ctl.play;
        this._pillBtn = iconButton('subtitles', 22, 'cae-flat', () => this.setLyricPill(!this.lyricPill.enabled));
        if (this.lyricPill.enabled) this._pillBtn.add_style_pseudo_class('checked');
        ctl.box.add_child(this._pillBtn);
        this._pinBtn = iconButton('push_pin', 22, 'cae-flat', () => this.setLyricPillPinned(!this.lyricPill.pinned));
        ctl.box.add_child(this._pinBtn);
        this._syncPinBtn();
        col.add_child(ctl.box);
        row.add_child(col);

        this._lyrics = new LyricsView(this.media, 380, 340);
        row.add_child(this._lyrics.actor);
        page.add_child(row);
        return page;
    }

    _perfCard(name, ic, color) {
        const c = card('cae-perf', vbox);
        c.x_expand = true;
        const wrap = new St.Widget({width: 150, height: 150, layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        const ring = new Ring(this.shell.theme, 150, {thickness: 12, color});
        const mid = vbox('', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const big = label('0%', 'cae-perf-big', {x_align: Clutter.ActorAlign.CENTER});
        mid.add_child(new Icon(ic, 22, {fill: true, style_class: `cae-${color}`}));
        mid.add_child(big);
        wrap.add_child(ring);
        wrap.add_child(mid);
        c.add_child(wrap);
        c.add_child(label(name, 'cae-perf-name', {x_align: Clutter.ActorAlign.CENTER}));
        const sub = label('', 'cae-perf-sub', {x_align: Clutter.ActorAlign.CENTER});
        c.add_child(sub);
        return {card: c, set: (v, s) => { ring.setValue(v); big.text = `${Math.round(v * 100)}%`; sub.text = s; }};
    }

    _buildPerf() {
        const root = hbox('cae-grid');
        root.set_width(1000);
        this._pCpu = this._perfCard('Processor', 'memory', 'primary');
        this._pMem = this._perfCard('Memory', 'memory_alt', 'secondary');
        this._pDisk = this._perfCard('Storage', 'hard_drive', 'tertiary');
        const n = card('cae-perf', vbox);
        n.x_expand = true;
        n.add_child(label('Network', 'cae-perf-name', {x_align: Clutter.ActorAlign.CENTER}));
        const row = (ic, s) => {
            const r = hbox('cae-net-row', {x_align: Clutter.ActorAlign.CENTER});
            r.add_child(new Icon(ic, 26, {style_class: s}));
            const l = label('0 B/s', 'cae-net-speed');
            r.add_child(l);
            n.add_child(r);
            return l;
        };
        this._pDown = row('arrow_downward', 'cae-primary');
        this._pUp = row('arrow_upward', 'cae-tertiary');
        this._pTemp = label('', 'cae-perf-sub', {x_align: Clutter.ActorAlign.CENTER});
        n.add_child(this._pTemp);
        for (const c of [this._pCpu.card, this._pMem.card, this._pDisk.card, n]) root.add_child(c);
        return root;
    }

    _tick() {
        const s = this.stats;
        if (!this.drawer?.isOpen) return;
        s.sample();
        const now = GLib.DateTime.new_now_local();
        this._dT.text = now.format('%H:%M');
        this._dD.text = now.format('%A, %-d %B');
        this._rCpu.set(s.cpu);
        this._rMem.set(s.mem);
        this._rDisk.set(s.disk);
        this._pCpu.set(s.cpu, s.temp ? `${Math.round(s.temp)}°C` : '');
        this._pMem.set(s.mem, `${bytes(s.memUsed)} / ${bytes(s.memTotal)}`);
        this._pDisk.set(s.disk, `${bytes(s.diskUsed)} / ${bytes(s.diskTotal)}`);
        this._pDown.text = `${bytes(s.down)}/s`;
        this._pUp.text = `${bytes(s.up)}/s`;
        this._pTemp.text = s.temp ? `CPU ${Math.round(s.temp)}°C` : '';
    }

    async _weather() {
        const {latitude: lat, longitude: lon, place} = this.config;
        try {
            const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
            const cur = d.current;
            const w = WEATHER.find(x => x[0].includes(cur.weather_code)) ?? WEATHER[2];
            this._wIcon.setIcon(w[1], true);
            this._wTemp.text = `${Math.round(cur.temperature_2m)}°C`;
            this._wDesc.text = `${w[2]}, ${place}`;
        } catch (e) { console.debug(`caelestia-gnome weather: ${e.message}`); }
    }

    _syncMedia() {
        const m = this.media, t = m.track;
        const app = m.musicApp?.get_name();
        const title = t?.title ?? 'Nothing playing';
        const put = (l, text) => {
            if (l.text === text) return;
            if (this.drawer?.isOpen) swap(l, () => { l.text = text; }, {out: 110, back: 300});
            else l.text = text;
        };
        put(this._mTitle, title);
        put(this._mAlbum, t?.album ?? '');
        this._mAlbum.visible = !!t?.album;
        put(this._mArtist, t?.artist ?? (app ? `Press play to open ${app}` : ''));
        put(this._bTitle, title);
        put(this._bAlbum, t?.album ?? '');
        put(this._bArtist, t?.artist ?? (app ? `Press play to open ${app}` : ''));
        const ic = m.playing ? 'pause' : 'play_arrow';
        this._mPlay.setIcon(ic, true);
        this._bPlay.setIcon(ic, true);
        this._bSource.visible = !!t;
        this._bSource.child.text = m.players.length > 1 ? `${m.playerName}  ⇄` : m.playerName;
        this._cover.set(t?.art ?? null);
        this._bigCover.set(t?.art ?? null);
        this._backdrop.set(t?.blur ?? null);
        const accent = t?.accent ?? null;
        if (accent !== this._accent) {
            this._accent = accent;
            this._seek.setAccent(accent);
            this._bTitle.style = accent ? `color: ${accent};` : '';
        }
        this._lyrics.sync();
        this._syncProgress();
        this._syncTimers();
    }

    _syncSeek() {
        const t = this.media.track;
        const pos = this.media.position, len = t?.length ?? 0;
        this._seek.set(len ? Math.min(1, pos / len) : 0);
        const a = fmtTime(t ? pos : 0), b = fmtTime(len);
        if (this._bPos.text !== a) this._bPos.text = a;
        if (this._bLen.text !== b) this._bLen.text = b;
    }

    _syncProgress() {
        const t = this.media.track;
        const pos = this.media.position, len = t?.length ?? 0;
        this._ring.setValue(len ? Math.min(1, pos / len) : 0);
        this._syncSeek();
    }

    destroy() {
        // First: the player reports changes as it shuts down, and nothing below should hear them.
        this.media.destroy();
        if (this._settle) GLib.source_remove(this._settle);
        if (this._statsTimer) GLib.source_remove(this._statsTimer);
        if (this._ticker) GLib.source_remove(this._ticker);
        this._stopWeather();
        this._lyrics.destroy();
        this._cal.destroy();
        this.lyricPill.destroy();
        this.themes.destroy();
        this.drawer.destroy();
    }
}
