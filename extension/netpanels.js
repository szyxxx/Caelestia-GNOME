import 'gi://GnomeBluetooth?version=3.0';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import NM from 'gi://NM';
import Polkit from 'gi://Polkit';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Icon, button, hbox, label, vbox} from './ui.js';
import {ms} from './motion.js';

/**
 * Wi-Fi and Bluetooth set-up inside the bar popouts, built on the same calls GNOME's quick settings
 * use. New Wi-Fi networks go through NetworkManager, which asks GNOME's own password dialog;
 * enterprise networks (eduroam and the like) open the Settings 802.1X dialog, as GNOME does.
 * Scanning runs only while a popout is open: each panel returns a cleanup that stops it.
 */

const MAX_ROWS = 12;
const MAX_LIST = 320;   // px; matches .cae-pop-scroll
const SecFlags = NM['80211ApSecurityFlags'];
const ApFlags = NM['80211ApFlags'];
const BUSY = [NM.DeviceState.PREPARE, NM.DeviceState.CONFIG, NM.DeviceState.NEED_AUTH,
    NM.DeviceState.IP_CONFIG, NM.DeviceState.IP_CHECK, NM.DeviceState.SECONDARIES];

export function launchSettings(panel, ...args) {
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop');
    const param = new GLib.Variant('av', [new GLib.Variant('(sav)', [panel, args.map(s => new GLib.Variant('s', s))])]);
    app?.activate_action('launch-panel', param, 0, -1, null).catch(e => console.debug(`caelestia-gnome settings: ${e.message}`));
}

/** Coalesce bursts of signals into one rebuild on idle. */
function batcher(fn) {
    let id = 0;
    const run = () => {
        if (id) return;
        id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { id = 0; fn(); return GLib.SOURCE_REMOVE; });
    };
    run.cancel = () => { if (id) GLib.source_remove(id); id = 0; };
    return run;
}

/**
 * Rows keyed by name and updated in place. Scans and device events arrive in bursts; rebuilding
 * would destroy the row under the pointer between press and release and lose the click.
 * A spec with `section` is a small heading instead of a row.
 */
class Rows {
    constructor() {
        this.actor = vbox('cae-pop-list');
        this._rows = new Map();
    }

    /** @param specs [{key, icon, name, sub, active, accent, trailing, onClick} | {key, section, error}] in display order */
    sync(specs) {
        const keep = new Set(specs.map(s => s.key));
        for (const [k, r] of this._rows) if (!keep.has(k)) { r.actor.destroy(); this._rows.delete(k); }
        specs.forEach((spec, i) => {
            let r = this._rows.get(spec.key);
            if (!r) {
                r = spec.section !== undefined ? {actor: label('', 'cae-pop-section'), heading: true} : this._make();
                this._rows.set(spec.key, r);
                this.actor.add_child(r.actor);
            }
            if (r.heading) {
                r.actor.text = spec.section;
                r.actor[spec.error ? 'add_style_class_name' : 'remove_style_class_name']('cae-pop-note');
            } else {
                r.onClick = spec.onClick;
                r.icon.setIcon(spec.icon, !!spec.active);
                r.icon.style_class = `cae-icon ${spec.active || spec.accent ? 'cae-primary' : 'cae-pop-item-icon'}`;
                r.name.text = spec.name;
                r.sub.text = spec.sub ?? '';
                r.sub.visible = !!spec.sub;
                r.trail.visible = !!spec.trailing;
                if (spec.trailing) r.trail.setIcon(spec.trailing);
                r.trail.style_class = `cae-icon ${spec.active ? 'cae-primary' : 'cae-bar-dim'}`;
                r.actor[spec.active ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
            }
            if (this.actor.get_child_at_index(i) !== r.actor) this.actor.set_child_at_index(r.actor, i);
        });
    }

    _make() {
        // Fill the button so every name starts at the same place (St.Button centres its child).
        const row = hbox('cae-pop-item-inner', {x_expand: true, x_align: Clutter.ActorAlign.FILL});
        const icon = new Icon('wifi', 20);
        const t = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const name = label('', 'cae-pop-item-name');
        name.clutter_text.ellipsize = 3;
        const sub = label('', 'cae-pop-item-sub');
        sub.clutter_text.ellipsize = 3;
        t.add_child(name);
        t.add_child(sub);
        const trail = new Icon('lock', 15, {y_align: Clutter.ActorAlign.CENTER});
        row.add_child(icon);
        row.add_child(t);
        row.add_child(trail);
        const r = {icon, name, sub, trail, onClick: null};
        r.actor = button(row, 'cae-pop-item', () => r.onClick?.(), {x_expand: true});
        return r;
    }
}

/** A list that scrolls past a set height, so a long list never pushes the panel off the screen. */
function scroller(rows) {
    const scroll = new St.ScrollView({style_class: 'cae-pop-scroll', hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.EXTERNAL, x_expand: true});
    scroll.child = rows.actor;
    return scroll;
}

/** A small on/off switch. set() does not call onToggle, so state changes from elsewhere cannot loop. */
export class Switch {
    constructor(onToggle) {
        this._knob = new St.Widget({style_class: 'cae-switch-knob', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
        this.actor = button(this._knob, 'cae-switch', () => onToggle(!this.on), {y_align: Clutter.ActorAlign.CENTER});
        this.on = false;
    }

    set(on, animate = true) {
        if (on === this.on && animate) return;
        this.on = on;
        this.actor[on ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
        this._knob.ease({translation_x: on ? 16 : 0, duration: animate ? ms(180) : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
}

/** Title, then settings and the switch on the right: the same head on every network panel. */
function head(box, {icon, title, onToggle, onSettings}) {
    const row = hbox('cae-net-head');
    const ic = new Icon(icon, 22, {fill: true, style_class: 'cae-primary'});
    row.add_child(ic);
    const name = label(title, 'cae-pop-title', {x_expand: true});
    row.add_child(name);
    row.add_child(button(new Icon('settings', 18, {style_class: 'cae-pop-item-icon'}), 'cae-pop-gear', onSettings, {y_align: Clutter.ActorAlign.CENTER}));
    const sw = new Switch(onToggle);
    row.add_child(sw.actor);
    box.add_child(row);
    return {sw, ic, name};
}

// ---------------------------------------------------------------- Wi-Fi

const ssidOf = ap => {
    const s = ap.get_ssid();
    return s ? NM.utils_ssid_to_utf8(s.get_data()) : '';
};
const bars = s => s > 75 ? 'network_wifi' : s > 50 ? 'network_wifi_3_bar' : s > 25 ? 'network_wifi_2_bar' : 'network_wifi_1_bar';
const secured = ap => (ap.get_flags() & ApFlags.PRIVACY) || ap.get_wpa_flags() || ap.get_rsn_flags();
const enterprise = ap => ((ap.get_wpa_flags() | ap.get_rsn_flags()) & SecFlags.KEY_MGMT_802_1X) !== 0;

/**
 * @param box container to fill
 * @param opts.nm NM.Client
 * @param opts.services for the Wi-Fi switch and any wired connection
 * @param opts.close closes the popout (used before a dialog takes over)
 * @param opts.resized called after the list changes size
 * @param opts.rate text for the live speed on the connected row
 * @returns {cleanup, refresh}
 */
export function wifiPanel(box, {nm, services, close, resized = () => {}, rate = () => ''}) {
    const dev = nm?.get_devices().find(d => d instanceof NM.DeviceWifi);
    const h = head(box, {icon: 'wifi', title: 'Wi-Fi', onToggle: on => { services.wifi = on; },
        onSettings: () => { close(); launchSettings('wifi'); }});
    h.sw.actor.visible = !!dev;
    const rows = new Rows(), scroll = scroller(rows);
    box.add_child(scroll);
    let pending = null;   // SSID we asked to join, shown as "Connecting…"
    let note = '', tallest = 0;

    const render = () => {
        const on = !!dev && nm.wireless_enabled;
        h.sw.set(on);
        h.ic.setIcon(on ? 'wifi' : 'wifi_off', true);
        scroll.visible = on || !dev || services.net.kind === 'Wired';
        const specs = [];
        if (services.net.kind && services.net.kind !== 'Wi-Fi')
            specs.push({key: 'wired', icon: 'lan', name: services.net.name, sub: ['Connected', rate()].filter(Boolean).join(' · '), active: true, trailing: 'check', onClick: () => {}});
        if (!dev) specs.push({key: 'none', section: 'No Wi-Fi adapter'});
        if (on) {
            // One row per network name, strongest access point first.
            const best = new Map();
            for (const ap of dev.get_access_points()) {
                const ssid = ssidOf(ap);
                if (!ssid) continue;
                if (!best.has(ssid) || ap.get_strength() > best.get(ssid).get_strength()) best.set(ssid, ap);
            }
            const busy = BUSY.includes(dev.get_state());
            const activeSsid = dev.get_active_access_point() ? ssidOf(dev.get_active_access_point()) : null;
            const current = busy ? pending ?? activeSsid : activeSsid;
            const conns = nm.get_connections();
            const saved = ap => conns.some(c => ap.connection_valid(c));
            // Coarse signal bands, so a flickering signal does not shuffle rows under the pointer.
            const band = ap => ap.get_strength() > 66 ? 2 : ap.get_strength() > 33 ? 1 : 0;
            const stable = (a, b) => band(b) - band(a) || GLib.utf8_collate(ssidOf(a), ssidOf(b));
            const row = ap => {
                const ssid = ssidOf(ap);
                const here = ssid === current;
                let sub = enterprise(ap) && !saved(ap) ? 'Sign-in required' : '';
                if (here) sub = busy ? 'Connecting…' : ['Connected', rate()].filter(Boolean).join(' · ');
                return {key: ssid, icon: bars(ap.get_strength()), name: ssid, sub, active: here && !busy,
                    trailing: here && !busy ? 'check' : secured(ap) ? 'lock' : null, onClick: () => join(ap)};
            };
            const all = [...best.values()];
            const top = all.filter(ap => ssidOf(ap) === current);
            const known = all.filter(ap => ssidOf(ap) !== current && saved(ap)).sort(stable);
            const other = all.filter(ap => ssidOf(ap) !== current && !saved(ap)).sort(stable).slice(0, MAX_ROWS);
            specs.push(...top.map(row));
            if (note) specs.push({key: '§note', section: note, error: true});
            if (known.length) specs.push({key: '§saved', section: 'Saved'}, ...known.map(row));
            if (other.length) specs.push({key: '§other', section: 'Other networks'}, ...other.map(row));
            if (!all.length) specs.push({key: '§empty', section: 'Looking for networks…'});
        }
        rows.sync(specs);
        // Only ever grow while open: a list that shrinks mid-scan moves everything under the pointer.
        const [, nat] = rows.actor.get_preferred_height(-1);
        tallest = Math.max(tallest, nat);
        scroll.style = `min-height: ${Math.min(tallest, MAX_LIST)}px;`;
    };

    const join = ap => {
        const ssid = ssidOf(ap);
        const active = dev.get_active_access_point();
        if (active && ssidOf(active) === ssid && !BUSY.includes(dev.get_state())) return;
        pending = ssid;
        note = '';
        const [conn] = nm.get_connections().filter(c => ap.connection_valid(c));
        if (conn) {
            nm.activate_connection_async(conn, dev, null, null, (c, r) => {
                try { c.activate_connection_finish(r); } catch (e) { note = `Could not join ${ssid}`; console.debug(e.message); }
                queue();
            });
        } else if (enterprise(ap)) {
            close();
            launchSettings('wifi', 'connect-8021x-wifi', NM.Object.prototype.get_path.call(dev), ap.get_path());
        } else {
            const c = new NM.SimpleConnection();
            let shared = false;
            try { shared = Polkit.Permission.new_sync('org.freedesktop.NetworkManager.settings.modify.system', null, null)?.get_allowed(); } catch {}
            if (!shared) {
                const s = new NM.SettingConnection();
                s.add_permission('user', GLib.get_user_name(), null);
                c.add_setting(s);
            }
            // For a secured network NetworkManager now asks GNOME's password dialog.
            if (secured(ap)) close();
            nm.add_and_activate_connection_async(c, dev, ap.get_path(), null, (cl, r) => {
                try { cl.add_and_activate_connection_finish(r); } catch (e) { note = `Could not join ${ssid}`; console.debug(e.message); }
                queue();
            });
        }
        queue();
    };

    const queue = batcher(() => { render(); resized(); });
    services.connectObject('changed', queue, rows.actor);
    if (dev) {
        dev.connectObject('access-point-added', queue, 'access-point-removed', queue,
            'notify::active-access-point', queue, 'state-changed', (d, s) => {
                if (s === NM.DeviceState.ACTIVATED) pending = null;
                if (s === NM.DeviceState.FAILED && pending) { note = `Could not join ${pending}`; pending = null; }
                queue();
            }, rows.actor);
        dev.request_scan_async(null, (d, r) => { try { d.request_scan_finish(r); } catch {} });
    }
    nm?.connectObject('notify::wireless-enabled', queue, rows.actor);
    h.sw.set(!!dev && nm.wireless_enabled, false);
    render();
    return {
        refresh: queue,
        cleanup: () => {
            queue.cancel();
            services.disconnectObject(rows.actor);
            dev?.disconnectObject(rows.actor);
            nm?.disconnectObject(rows.actor);
        },
    };
}

// ---------------------------------------------------------------- Bluetooth

let client = null;
/** One client for the session; it only listens to BlueZ, so it costs nothing while idle. */
export function bluetoothClient() {
    client ??= new GnomeBluetooth.Client();
    return client;
}
export function dropBluetoothClient() {
    if (client) client.default_adapter_setup_mode = false;
    client = null;
}

const devIcon = d => {
    const i = `${d.icon ?? ''}`;
    if (/head|audio|speaker/.test(i)) return 'headphones';
    if (/keyboard/.test(i)) return 'keyboard';
    if (/mouse|tablet/.test(i)) return 'mouse';
    if (/phone/.test(i)) return 'smartphone';
    if (/computer/.test(i)) return 'computer';
    if (/gaming|joystick/.test(i)) return 'sports_esports';
    return 'bluetooth';
};
const battery = d => d.battery_type !== GnomeBluetooth.BatteryType.NONE && d.battery_percentage > 0 ? ` · ${Math.round(d.battery_percentage)}%` : '';
const named = d => d.alias && d.alias.replace(/[-:]/g, '').toUpperCase() !== `${d.address}`.replace(/:/g, '').toUpperCase();

/**
 * Paired devices connect or disconnect with a click. "Pair new device" searches while the popout
 * stays open; devices that pair without a PIN (earbuds, speakers, most mice) pair right here, and
 * anything that needs a PIN or code is sent to Settings, which has the dialog for it.
 */
export function bluetoothPanel(box, {services, close, resized = () => {}}) {
    const bt = bluetoothClient();
    const h = head(box, {icon: 'bluetooth', title: 'Bluetooth', onToggle: on => { services.btOn = on; },
        onSettings: () => { close(); launchSettings('bluetooth'); }});
    const rows = new Rows(), scroll = scroller(rows);
    box.add_child(scroll);
    const state = new Map();   // path -> 'Connecting…' etc.
    let searching = false;
    let note = '';

    const devices = () => {
        const store = bt.get_devices(), out = [];
        for (let i = 0; i < store.get_n_items(); i++) out.push(store.get_item(i));
        return out;
    };

    const render = () => {
        const on = services.btOn;
        h.sw.set(on);
        h.ic.setIcon(on ? 'bluetooth' : 'bluetooth_disabled', true);
        scroll.visible = on;
        if (!on) {
            rows.sync([]);
            return;
        }
        const all = devices();
        const paired = all.filter(d => d.paired || d.trusted).sort((a, b) => b.connected - a.connected || a.alias.localeCompare(b.alias));
        const specs = [];
        if (paired.length) specs.push({key: '§mine', section: 'My devices'});
        for (const d of paired) {
            const path = d.get_object_path();
            specs.push({key: path, icon: devIcon(d), name: d.alias, active: d.connected, onClick: () => toggle(d),
                trailing: d.connected ? 'check' : null,
                sub: state.get(path) ?? (d.connected ? `Connected${battery(d)}` : '')});
        }
        if (note) specs.push({key: '§note', section: note, error: true});
        if (searching) {
            const found = all.filter(d => !d.paired && !d.trusted && named(d)).slice(0, MAX_ROWS);
            specs.push({key: '§near', section: found.length ? 'Nearby' : 'Searching… put the device in pairing mode'});
            for (const d of found) {
                const path = d.get_object_path();
                specs.push({key: path, icon: devIcon(d), name: d.alias, sub: state.get(path) ?? '', trailing: 'add', onClick: () => pair(d)});
            }
        } else {
            specs.push({key: '§pair', icon: 'add', name: 'Pair new device', accent: true, onClick: () => {
                searching = true;
                bt.default_adapter_setup_mode = true;
                queue();
            }});
        }
        rows.sync(specs);
    };

    const toggle = d => {
        const path = d.get_object_path(), on = !d.connected;
        state.set(path, on ? 'Connecting…' : 'Disconnecting…');
        note = '';
        bt.connect_service(path, on, null, (c, r) => {
            try { c.connect_service_finish(r); } catch (e) { note = `${d.alias}: ${on ? 'could not connect' : 'could not disconnect'}`; console.debug(e.message); }
            state.delete(path);
            queue();
        });
        queue();
    };

    const pair = d => {
        const path = d.get_object_path();
        state.set(path, 'Pairing…');
        note = '';
        queue();
        const props = (name, v) => Gio.DBus.system.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.bluez.Device1', name, v]), null, Gio.DBusCallFlags.NONE, -1, null, null);
        Gio.DBus.system.call('org.bluez', path, 'org.bluez.Device1', 'Pair', null, null, Gio.DBusCallFlags.NONE, 60000, null, (c, r) => {
            try {
                c.call_finish(r);
                props('Trusted', GLib.Variant.new_boolean(true));
                state.set(path, 'Connecting…');
                bt.connect_service(path, true, null, (cl, rr) => {
                    try { cl.connect_service_finish(rr); } catch (e) { console.debug(e.message); }
                    state.delete(path);
                    queue();
                });
            } catch (e) {
                state.delete(path);
                // No PIN dialog of our own: hand over to Settings, which has one.
                note = /AuthenticationFailed|AuthenticationRejected|AuthenticationCanceled|NotReady/.test(e.message)
                    ? `${d.alias} needs a PIN. Pair it in Bluetooth settings.` : `${d.alias}: pairing failed`;
                console.debug(e.message);
            }
            queue();
        });
    };

    const queue = batcher(() => { render(); resized(); });
    const watch = d => d.connectObject('notify::connected', queue, 'notify::paired', queue, 'notify::trusted', queue,
        'notify::alias', queue, 'notify::battery-percentage', queue, rows.actor);
    devices().forEach(watch);
    bt.connectObject('device-added', (c, d) => { watch(d); queue(); }, 'device-removed', queue, rows.actor);
    services.connectObject('changed', queue, rows.actor);
    h.sw.set(services.btOn, false);
    render();
    return () => {
        queue.cancel();
        if (searching) bt.default_adapter_setup_mode = false;
        bt.disconnectObject(rows.actor);
        services.disconnectObject(rows.actor);
        for (const d of devices()) d.disconnectObject(rows.actor);
    };
}
