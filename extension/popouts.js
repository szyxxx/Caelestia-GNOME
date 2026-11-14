import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Drawer, Icon, Slider, button, hbox, label, vbox} from './ui.js';
import {enter} from './motion.js';
import {bytes} from './services.js';
import {readText} from './util.js';
import {qr} from './qr.js';
import {Switch, bluetoothPanel, dropBluetoothClient, wifiPanel} from './netpanels.js';

const DWELL = 110, LINGER = 260;
const PROFILES = [['power-saver', 'energy_savings_leaf', 'Saver'], ['balanced', 'balance', 'Balanced'], ['performance', 'bolt', 'Boost']];

function clockText(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.round(s / 60) % 60;
    return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Caelestia's bar popouts: rest on a bar icon and a panel grows out of the bar beside it. Moving to
 * another icon morphs the same panel to the new place and size rather than closing and reopening.
 */
export class Popouts {
    constructor(shell) {
        this.shell = shell;
        this.content = vbox('cae-popout', {reactive: true, track_hover: true});
        this.drawer = new Drawer(shell, 'left', this.content, {modal: false});
        this.content.connect('notify::hover', () => { if (this.content.hover) this._cancel(); else this._leave(); });
        // Any other route to closing (a modal panel opening, say) still has to stop the live timer.
        this.drawer.onClose = () => { this._stopLive(); this._key = null; };
        this._key = null;
        this._cleanups = [];
    }

    hover(key, actor) {
        this._cancel();
        this._dwell = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DWELL, () => {
            this._dwell = 0;
            if (!this.shell.anyModalOpen()) this._show(key, actor);
            return GLib.SOURCE_REMOVE;
        });
    }

    leave() { this._leave(); }

    _leave() {
        if (this._dwell) { GLib.source_remove(this._dwell); this._dwell = 0; }
        if (this._linger) return;
        this._linger = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER, () => {
            this._linger = 0;
            if (this.content.hover) return GLib.SOURCE_REMOVE;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel() {
        if (this._dwell) GLib.source_remove(this._dwell);
        if (this._linger) GLib.source_remove(this._linger);
        this._dwell = this._linger = 0;
    }

    close() { this.drawer.close(); }

    _show(key, actor) {
        const [, y] = actor.get_transformed_position();
        const [, h] = actor.get_transformed_size();
        this.drawer.setAnchor(y + h / 2);
        if (key === this._key && this.drawer.isOpen) { this.drawer.relayout(); return; }
        const wasOpen = this.drawer.isOpen;
        this._key = key;
        this._stopLive();
        this.content.destroy_all_children();
        // List panels hold one width: a long status line must ellipsize, not stretch the panel.
        this.drawer.setFixedWidth(key === 'phone' ? 344 : ['network', 'bluetooth'].includes(key) ? 320 : -1);
        this[`_${key}`]();
        if (!wasOpen) {
            this.drawer.open({quiet: true});
            return;
        }
        this.drawer.relayout();
        for (const c of this.content.get_children()) enter(c, {duration: 260, dx: -6});
    }

    _head(icon, title, sub, style = 'cae-primary') {
        const row = hbox('cae-pop-head');
        row.add_child(new Icon(icon, 26, {fill: true, style_class: style}));
        const t = vbox('', {y_align: Clutter.ActorAlign.CENTER});
        t.add_child(label(title, 'cae-pop-title'));
        if (sub) {
            const s = label(sub, 'cae-pop-sub');
            t.add_child(s);
            this._sub = s;
        }
        row.add_child(t);
        this.content.add_child(row);
    }

    _live(fn, seconds = 2) {
        fn();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => { fn(); return GLib.SOURCE_CONTINUE; });
    }

    _stopLive() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
        for (const fn of this._cleanups.splice(0)) fn();
        this.shell.services.disconnectObject(this);
    }

    _audio() {
        const s = this.shell.services;
        this._head(s.volumeIcon, s.sinkName, `${Math.round(s.volume * 100)}%${s.muted ? ', muted' : ''}`);
        this.content.width = 300;
        const sl = new Slider(s.volumeIcon, {thickness: 26});
        sl.value = s.volume;
        sl.setValue(s.volume);
        sl.connect('changed', (a, v) => { s.volume = v; });
        this.content.add_child(sl);
        this.content.add_child(button(label('Mute', 'cae-pop-action'), 'cae-pop-btn', () => s.toggleMute()));
        s.connectObject('changed', () => {
            sl.setValue(s.volume);
            this._sub.text = `${Math.round(s.volume * 100)}%${s.muted ? ', muted' : ''}`;
        }, this);
    }

    _network() {
        const s = this.shell.services;
        this.content.width = 320;
        const st = this.shell.dashboard.stats;
        st.resetRates();
        let speed = '', panel = null;
        panel = wifiPanel(this.content, {nm: s.nmClient, services: s, close: () => this.close(),
            resized: () => this.drawer.relayout(), rate: () => speed});
        this._cleanups.push(panel.cleanup);
        // Live speed on the connected row, only while this panel is open.
        this._live(() => {
            st.sample();
            speed = st.down || st.up ? `↓ ${bytes(st.down)}/s  ↑ ${bytes(st.up)}/s` : '';
            panel.refresh();
        });
    }

    _bluetooth() {
        this.content.width = 320;
        this._cleanups.push(bluetoothPanel(this.content, {services: this.shell.services, close: () => this.close(), resized: () => this.drawer.relayout()}));
    }

    /** The paired phone (GSConnect): battery, clipboard both ways, send files, browse, ring. */
    _phone() {
        const p = this.shell.phone;
        this.content.width = 344;
        const describe = () => {
            const d = p.device;
            if (!d) return 'No phone paired';
            if (!d.connected) return 'Not connected · same Wi-Fi?';
            const b = p.battery;
            return b ? `Connected · ${b.level}%${b.charging ? ', charging' : ''}` : 'Connected';
        };
        this._head(p.device?.connected ? 'smartphone' : 'phonelink_off', p.device?.name ?? 'Phone', describe());
        const title = this.content.get_first_child().get_last_child().get_first_child();
        const grid = vbox('cae-pop-list');
        const tile = (icon, text, run, action) => {
            const box = hbox('cae-chip-inner', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new Icon(icon, 18));
            box.add_child(label(text, 'cae-chip-label'));
            const b = button(box, 'cae-chip cae-phone-tile', run, {x_expand: true});
            b._action = action;
            return b;
        };
        const rows = [
            [tile('upload_file', 'Send files', () => { this.close(); p.activate('share'); }, 'share'),
                tile('folder_open', 'Browse', () => { this.close(); p.browse(); }, 'mount')],
            [tile('content_paste_go', 'Send clipboard', () => p.activate('clipboardPush'), 'clipboardPush'),
                tile('content_paste', 'Get clipboard', () => p.activate('clipboardPull'), 'clipboardPull')],
        ];
        for (const r of rows) {
            const row = hbox('cae-pop-row cae-pop-chips', {x_expand: true});
            row.layout_manager.homogeneous = true;
            r.forEach(t => row.add_child(t));
            grid.add_child(row);
        }
        this.content.add_child(grid);
        this._phoneLinkSection();
        // The same gear as the Wi-Fi and Bluetooth panels; only a first-time set-up needs a real button.
        const headRow = this.content.get_first_child();
        headRow.get_last_child().x_expand = true;
        // Ring sits in the head, beside the gear: four even tiles below instead of an odd fifth one.
        const ring = button(new Icon('ring_volume', 18, {style_class: 'cae-pop-item-icon'}), 'cae-pop-gear cae-phone-ring',
            () => p.activate('ring'), {y_align: Clutter.ActorAlign.CENTER});
        headRow.add_child(ring);
        headRow.add_child(button(new Icon('settings', 18, {style_class: 'cae-pop-item-icon'}), 'cae-pop-gear cae-phone-head-gear',
            () => { this.close(); p.openSettings(); }, {y_align: Clutter.ActorAlign.CENTER}));
        const settings = button(label('Set up a phone', 'cae-pop-action'), 'cae-pop-btn', () => { this.close(); p.openSettings(); });
        this.content.add_child(settings);
        const sync = () => {
            title.text = p.device?.name ?? 'Phone';
            this._sub.text = describe();
            grid.visible = !!p.device?.connected;
            for (const r of rows) for (const t of r) t.reactive = p.can(t._action), t.opacity = p.can(t._action) ? 255 : 110;
            ring.visible = !!p.device?.connected && p.can('ring');
            settings.visible = !p.device;
            this.drawer.relayout();
        };
        sync();
        p.connectObject('changed', sync, this);
        this._cleanups.push(() => p.disconnectObject(this));
    }

    /**
     * Phone Link: the laptop's own hotspot, for when phone and laptop share no Wi-Fi.
     * A head like the Wi-Fi panel's (icon, name + status, switch), then Auto and the join QR code.
     */
    _phoneLinkSection() {
        const L = this.shell.phoneLink;
        if (!L) return;
        const box = vbox('cae-phonelink');
        box.add_child(new St.Widget({style_class: 'cae-pop-divider', x_expand: true}));

        const head = hbox('cae-link-head');
        const icon = new Icon('wifi_tethering', 22, {fill: true, y_align: Clutter.ActorAlign.CENTER});
        const text = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label('Phone Link hotspot', 'cae-link-title'));
        const sub = label('', 'cae-pop-sub');
        sub.clutter_text.line_wrap = true;
        text.add_child(sub);
        const sw = new Switch(on => (on ? L.start() : L.stop()));
        for (const a of [icon, text, sw.actor]) head.add_child(a);

        const chip = (ic, name, run) => {
            const inner = hbox('cae-chip-inner', {x_align: Clutter.ActorAlign.CENTER});
            inner.add_child(new Icon(ic, 18));
            inner.add_child(label(name, 'cae-chip-label'));
            return button(inner, 'cae-chip', run, {x_expand: true});
        };
        const chips = hbox('cae-pop-row cae-pop-chips', {x_expand: true});
        chips.layout_manager.homogeneous = true;
        const autoT = chip('autorenew', 'Auto', () => L.setAuto(!L.auto));
        const qrT = chip('qr_code_2', 'Join code', async () => {
            qrBox.visible = !qrBox.visible;
            if (qrBox.visible && !L.psk) await L.ensureProfile();
            sync();
        });
        chips.add_child(autoT);
        chips.add_child(qrT);

        // The QR code: dark modules on white with a 4-module quiet zone, as phone cameras expect.
        const SIZE = 196;
        const area = new St.DrawingArea({width: SIZE, height: SIZE, x_align: Clutter.ActorAlign.CENTER});
        area.connect('repaint', a => {
            const cr = a.get_context();
            cr.setSourceRGB(1, 1, 1);
            cr.paint();
            const t = L.joinText;
            if (t) {
                const q = qr(t);
                const cell = SIZE / (q.size + 8);
                cr.setSourceRGB(0, 0, 0);
                for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
                    if (q.dark(x, y)) cr.rectangle((x + 4) * cell, (y + 4) * cell, cell + 0.02, cell + 0.02);
                }
                cr.fill();
            }
            cr.$dispose();
        });
        const qrCard = new St.Bin({style_class: 'cae-qr-card', child: area, x_align: Clutter.ActorAlign.CENTER});
        const qrInfo = label('', 'cae-pop-sub', {x_align: Clutter.ActorAlign.CENTER});
        qrInfo.clutter_text.line_wrap = true;
        qrInfo.clutter_text.line_alignment = 1; // centre
        const qrBox = vbox('cae-qr-box', {visible: false});
        qrBox.add_child(qrCard);
        qrBox.add_child(qrInfo);

        for (const a of [head, chips, qrBox]) box.add_child(a);
        this.content.add_child(box);

        const mark = (t, on) => t[on ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        let shownText = null;
        const sync = () => {
            sw.set(L.active || (L.busy && !L.active));
            sw.actor.reactive = !L.busy && L.available;
            icon[L.active ? 'add_style_class_name' : 'remove_style_class_name']('cae-primary');
            icon[L.active ? 'remove_style_class_name' : 'add_style_class_name']('cae-dim');
            mark(autoT, L.auto);
            mark(qrT, qrBox.visible);
            const wifiNow = this.shell.services.net?.kind === 'Wi-Fi' ? this.shell.services.net.name : null;
            const n = L.clients;
            if (L.error) sub.text = L.error;
            else if (!L.available) sub.text = 'No Wi-Fi card found';
            else if (L.busy) sub.text = L.active ? 'Turning off…' : 'Turning on…';
            else if (L.active) sub.text = `${L.ssid} · ${n ? `${n} device${n > 1 ? 's' : ''}` : 'waiting for phone'}` +
                (L.dual && wifiNow ? ` · Wi-Fi stays on` : '');
            else if (L.auto) sub.text = L.dual ? 'Auto · when your phone is out of reach' : 'Auto · when there is no Wi-Fi';
            else sub.text = L.dual || !wifiNow ? 'Off' : `Off · turning on leaves ${wifiNow}`;
            if (L.error) sub.add_style_class_name('cae-pop-note'); else sub.remove_style_class_name('cae-pop-note');
            qrInfo.text = L.psk ? `Scan with your phone's camera\n${L.ssid} · ${L.psk}` : 'Preparing…';
            if (L.joinText !== shownText) { shownText = L.joinText; area.queue_repaint(); }
            this.drawer.relayout();
        };
        sync();
        L.connectObject('changed', sync, this);
        this.shell.services.connectObject('changed', sync, box);
        this._cleanups.push(() => { L.disconnectObject(this); this.shell.services.disconnectObject(box); });
    }

    _battery() {
        const s = this.shell.services;
        this.content.width = 320;
        const describe = () => {
            const b = s.battery;
            if (!b) return 'No battery';
            if (b.full) return 'Fully charged';
            if (b.charging) return b.toFull ? `${clockText(b.toFull)} until full` : 'Charging';
            return b.toEmpty ? `${clockText(b.toEmpty)} left, using ${b.watts.toFixed(1)} W` : `Using ${b.watts.toFixed(1)} W`;
        };
        this._head(s.batteryIcon ?? 'battery_unknown', `${Math.round(s.battery?.level ?? 0)}%`, describe());
        const title = this.content.get_first_child().get_last_child().get_first_child();
        const row = hbox('cae-pop-row cae-pop-chips');
        const chips = PROFILES.map(([id, ic, name]) => {
            const box = hbox('cae-chip-inner', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new Icon(ic, 18, {fill: true}));
            box.add_child(label(name, 'cae-chip-label'));
            const b = button(box, 'cae-chip', () => s.setProfile(id), {x_expand: true});
            row.add_child(b);
            return {b, id};
        });
        const sync = () => {
            title.text = `${Math.round(s.battery?.level ?? 0)}%`;
            this._sub.text = describe();
            for (const {b, id} of chips) {
                if (id === s.profile) b.add_style_pseudo_class('checked');
                else b.remove_style_pseudo_class('checked');
            }
        };
        this.content.add_child(row);

        // Charge limit, like macOS optimized charging: 80% is kinder to the battery, 100% for a long day out.
        // The first battery that has a charge limit (BAT0 on most laptops, BAT1 or BATT on others).
        const LIMIT = ['BAT0', 'BAT1', 'BATT', 'BATC'].map(b => `/sys/class/power_supply/${b}/charge_control_end_threshold`)
            .find(f => GLib.file_test(f, GLib.FileTest.EXISTS)) ?? null;
        const limitNow = () => parseInt((LIMIT && readText(LIMIT)) ?? '', 10) || 100;
        const canSet = () => Gio.File.new_for_path(LIMIT).query_info(
            'access::can-write', Gio.FileQueryInfoFlags.NONE, null).get_attribute_boolean('access::can-write');
        const limRow = hbox('cae-pop-row cae-pop-chips');
        const limChips = [[80, 'eco', 'Limit 80%'], [100, 'battery_full', 'Charge 100%']].map(([v, ic, name]) => {
            const box = hbox('cae-chip-inner', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new Icon(ic, 18, {fill: true}));
            box.add_child(label(name, 'cae-chip-label'));
            const b = button(box, 'cae-chip', () => {
                try {
                    GLib.spawn_async(null, [`${GLib.get_home_dir()}/.local/bin/caelestia-charge`, String(v)], null, 0, null);
                } catch (e) { logError(e); }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { syncLimit(); return GLib.SOURCE_REMOVE; });
            }, {x_expand: true});
            limRow.add_child(b);
            return {b, v};
        });
        const hint = label('Run once in a terminal: caelestia-charge --setup', 'cae-pop-sub', {visible: false});
        hint.clutter_text.line_wrap = true;
        const syncLimit = () => {
            const now = limitNow();
            let writable = false;
            try { writable = canSet(); } catch {}
            for (const {b, v} of limChips) {
                if (v === now) b.add_style_pseudo_class('checked');
                else b.remove_style_pseudo_class('checked');
                b.reactive = writable;
                b.opacity = writable ? 255 : 110;
            }
            hint.visible = !writable;
        };
        // No charge limit on this machine (a desktop, or a laptop whose firmware has none): leave the rows out.
        if (LIMIT) {
            this.content.add_child(limRow);
            this.content.add_child(hint);
        }
        syncLimit();
        sync();
        s.connectObject('changed', sync, this);
    }

    _clock() {
        const n = GLib.DateTime.new_now_local();
        this.content.width = 260;
        this._head('calendar_month', n.format('%A'), n.format('%d %B %Y'), 'cae-tertiary');
    }

    _window() {
        const w = global.display.focus_window;
        this.content.width = 340;
        this._head('web_asset', w?.title ?? 'Desktop', w?.get_wm_class() ?? '', 'cae-secondary');
        const title = this.content.get_first_child().get_last_child().get_first_child();
        title.clutter_text.ellipsize = 3;
        title.width = 270;
        const actor = w?.get_compositor_private();
        if (!actor) return;
        const [ww, wh] = actor.get_size();
        const W = 308, H = Math.min(200, Math.round(W * wh / Math.max(1, ww)));
        const frame = new St.Widget({style_class: 'cae-pop-preview', width: W, height: H, clip_to_allocation: true, layout_manager: new Clutter.FixedLayout()});
        const k = Math.min(W / ww, H / wh);
        const clone = new Clutter.Clone({source: actor, width: ww * k, height: wh * k, x: (W - ww * k) / 2, y: (H - wh * k) / 2});
        frame.add_child(clone);
        this.content.add_child(frame);
    }

    destroy() {
        this._cancel();
        this._stopLive();
        dropBluetoothClient();
        this.drawer.destroy();
    }
}

