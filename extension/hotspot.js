import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadConfig, readText, saveConfig} from './util.js';
import {wifiQrText} from './qr.js';

export const LINK_ID = 'Caelestia Phone Link';
const DUAL_UNIT = 'caelestia-ap0.service';
const DUAL_UNIT_FILE = `/etc/systemd/system/${DUAL_UNIT}`;
const DUAL_ENV = '/etc/caelestia/phonelink.env';
const DUAL_STATE = '/run/caelestia-phonelink/iface';
const START_AFTER = 30;     // s of "phone unreachable" before Auto raises the hotspot
const IDLE_SINGLE = 300;    // single radio: s with nobody on the hotspot before it steps down so Wi-Fi can rejoin
const IDLE_DUAL = 600;      // dual: s with nobody on it before it rests...
const REST_DUAL = 300;      // ...and s it rests before Auto raises it again
const BUSY = [NM.DeviceState.PREPARE, NM.DeviceState.CONFIG, NM.DeviceState.NEED_AUTH, NM.DeviceState.IP_CONFIG,
    NM.DeviceState.IP_CHECK, NM.DeviceState.SECONDARIES];

function run(argv) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            p.communicate_utf8_async(null, null, (o, r) => {
                try {
                    const [, out, err] = o.communicate_utf8_finish(r);
                    resolve({ok: o.get_successful(), out: out ?? '', err: err ?? ''});
                } catch (e) { resolve({ok: false, out: '', err: e.message}); }
            });
        } catch (e) { resolve({ok: false, out: '', err: e.message}); }
    });
}
const lastLine = (r, fallback) => (r.err.trim().split('\n').pop() || fallback).replace(/^Error:\s*/, '');
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);

/** KEY=value lines (the dual-mode settings the root helper uses). */
function readEnv(path) {
    const out = {};
    for (const l of (readText(path) ?? '').split('\n')) {
        const m = l.match(/^([A-Z_]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

/**
 * Phone Link: the laptop's own Wi-Fi hotspot, so the phone and GSConnect find each other with no shared
 * network.
 *
 * Two ways to run it:
 *  - dual (phonelink-setup.sh installed): a root helper (caelestia-ap0.service, startable without a password
 *    through polkit) runs a Wi-Fi Direct group owner next to the normal Wi-Fi connection, on its channel,
 *    with DHCP and NAT. The laptop stays online and the phone gets internet through it. (The RTL8852CE
 *    refuses a plain AP next to a station, but takes a P2P group owner; phones join it like any WPA2 network.)
 *  - single (no setup): a NetworkManager AP profile on wlp99s0 itself, which takes the laptop off other Wi-Fi.
 *
 * Auto mode: dual → up whenever the phone is not reachable through GSConnect some other way; rests after
 * IDLE_DUAL s with nobody on it. Single → up only when the laptop has no Wi-Fi; steps down after IDLE_SINGLE
 * s with nobody on it, so NetworkManager can look for a known network.
 *
 * Power: no polling while off. While on, one 60 s look at the ARP table (devices) and the helper's state.
 */
export class PhoneLink extends Signals.EventEmitter {
    constructor(services, phone = null) {
        super();
        this.services = services;
        this.phone = phone;
        const c = loadConfig();
        this.auto = !!c.phoneLinkAuto;
        this.ssid = c.phoneLinkSsid || `${GLib.get_host_name().split('.')[0]}-link`;
        this.psk = '';
        this.active = false;
        this.busy = false;
        this.clients = 0;
        this.error = '';
        this.apIface = null;
        this._userStopped = false;
        this._restUntil = 0;
        this._idleSince = 0;
        this._startTimer = this._checkTimer = this._hookTimer = this._restTimer = 0;
        this.phone?.connectObject('changed', () => this._sync(), this);
        this._hook();
    }

    /** Dual mode is possible once the root helper is installed and its settings are readable. */
    get dual() { return exists(DUAL_UNIT_FILE) && !!readEnv(DUAL_ENV).PL_SSID; }

    _hook() {
        const nm = this.services.nmClient;
        if (!nm) {
            this._hookTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._hookTimer = 0;
                this._hook();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this.nm = nm;
        nm.connectObject('notify::active-connections', () => this._sync(), 'notify::wireless-enabled', () => this._sync(),
            'notify::primary-connection', () => this._sync(), this);
        this.dev = nm.get_devices().find(d => d instanceof NM.DeviceWifi && !d.get_iface().startsWith('p2p-')) ?? null;
        this.dev?.connectObject('state-changed', () => this._sync(), this);
        this._loadSecret();
        this._sync();
    }

    get profile() { return this.nm?.get_connections().find(c => c.get_id() === LINK_ID) ?? null; }
    get available() { return !!this.dev; }

    /** Name + password for the QR code: the helper's settings in dual mode, NetworkManager's profile otherwise. */
    async _loadSecret() {
        if (this.dual) {
            const e = readEnv(DUAL_ENV);
            this.ssid = e.PL_SSID;
            this.psk = e.PL_PSK ?? '';
            this.emit('changed');
            return;
        }
        if (!this.profile) return;
        const r = await run(['nmcli', '-s', '-g', '802-11-wireless-security.psk,802-11-wireless.ssid', 'connection', 'show', LINK_ID]);
        if (r.ok) {
            const [psk, ssid] = r.out.trim().split('\n');
            this.psk = psk ?? '';
            if (ssid) this.ssid = ssid;
            this.emit('changed');
        }
    }

    /** Make sure a join code exists (creates the single-mode profile if needed). */
    async ensureProfile() {
        if (this.dual) { await this._loadSecret(); return true; }
        const ok = await this._ensureProfile();
        if (!ok) this.emit('changed');
        else await this._loadSecret();
        return ok;
    }

    async _ensureProfile() {
        if (this.profile) return true;
        // 12 letters/digits, no look-alikes: easy to type if the QR code is ever not an option.
        const chars = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
        const rnd = Gio.File.new_for_path('/dev/urandom').read(null).read_bytes(64, null).get_data();
        // Rejection sampling keeps every character equally likely.
        this.psk = Array.from(rnd).filter(b => b < 216 - 216 % chars.length).slice(0, 12).map(b => chars[b % chars.length]).join('');
        const r = await run(['nmcli', 'connection', 'add', 'type', 'wifi', 'ifname', this.dev.get_iface(), 'con-name', LINK_ID,
            'autoconnect', 'no', 'ssid', this.ssid, '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg',
            'ipv4.method', 'shared', 'ipv6.method', 'ignore', 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', this.psk,
            'wifi-sec.proto', 'rsn', 'wifi-sec.pairwise', 'ccmp', 'wifi-sec.group', 'ccmp']);
        if (!r.ok) this.error = lastLine(r, 'Could not create the hotspot');
        return r.ok;
    }

    /** The helper's group interface, if it is up. */
    _dualIface() {
        const i = (readText(DUAL_STATE) ?? '').trim();
        return i && exists(`/sys/class/net/${i}`) ? i : null;
    }

    async _helperError(fallback) {
        const j = await run(['journalctl', '-u', DUAL_UNIT, '-n', '20', '-o', 'cat', '--no-pager']);
        const line = j.out.split('\n').filter(l => l.startsWith('phonelink:')).pop();
        return line ? line.replace(/^phonelink:\s*/, '') : fallback;
    }

    async start() {
        if (!this.dev || this.busy) return;
        this.busy = true;
        this.error = '';
        this._userStopped = false;
        this.emit('changed');
        try {
            if (!this.nm.wireless_enabled) this.services.wifi = true;
            if (this.dual) {
                const u = await run(['systemctl', 'start', DUAL_UNIT]);
                this.apIface = this._dualIface();
                if (!u.ok || !this.apIface) {
                    this.error = await this._helperError(lastLine(u, 'Could not start the hotspot'));
                    run(['systemctl', 'stop', DUAL_UNIT]);
                    this.apIface = null;
                }
                await this._loadSecret();
                return;
            }
            if (!(await this._ensureProfile())) return;
            const iface = this.dev.get_iface();
            const m = await run(['nmcli', 'connection', 'modify', LINK_ID, 'connection.interface-name', iface,
                '802-11-wireless.band', 'bg', '802-11-wireless.channel', '']);
            if (!m.ok) { this.error = lastLine(m, 'Could not prepare the hotspot'); return; }
            this.apIface = iface;
            const r = await run(['nmcli', 'connection', 'up', 'id', LINK_ID, 'ifname', iface]);
            if (!r.ok) { this.error = lastLine(r, 'Could not start the hotspot'); this.apIface = null; }
        } finally {
            this.busy = false;
            this._sync();
        }
    }

    async stop({byUser = true} = {}) {
        if (byUser) this._userStopped = true;
        this.busy = true;
        this.emit('changed');
        if (this.dual) await run(['systemctl', 'stop', DUAL_UNIT]);
        if (this.nm?.get_active_connections().some(a => a.get_id() === LINK_ID)) await run(['nmcli', 'connection', 'down', 'id', LINK_ID]);
        this.apIface = null;
        this.busy = false;
        this._sync();
    }

    toggle() { return this.active ? this.stop() : this.start(); }

    setAuto(on) {
        this.auto = on;
        this._userStopped = false;
        this._restUntil = 0;
        saveConfig({phoneLinkAuto: on});
        this._sync();
    }

    /** The phone answers over GSConnect through some other network (not this hotspot). */
    get _phoneElsewhere() { return !!this.phone?.device?.connected && !this.clients; }

    _sync() {
        if (!this.nm) return;
        const acs = this.nm.get_active_connections();
        const link = acs.find(a => a.get_id() === LINK_ID);
        const dualIface = this.dual ? this._dualIface() : null;
        if (!this.busy) this.apIface = dualIface ?? (link ? this.dev?.get_iface() ?? null : null);
        this.active = !!dualIface || link?.get_state() === NM.ActiveConnectionState.ACTIVATED;
        const st = this.dev?.get_state();
        const wifiJoined = !link && st === NM.DeviceState.ACTIVATED;
        const wired = acs.some(a => a.get_id() !== LINK_ID && a.get_connection_type() === '802-3-ethernet' &&
            a.get_state() === NM.ActiveConnectionState.ACTIVATED);
        const dual = this.dual;
        if (wifiJoined && !dual) this._userStopped = false;
        // Dual: one radio, one channel. If the Wi-Fi it shared a channel with drops (roaming, a new network),
        // the group would keep it from reconnecting elsewhere: step aside; Auto brings it back afterwards.
        if (dual && this.active && !this.busy) {
            if (st === NM.DeviceState.ACTIVATED) this._staWasUp = true;
            else if (this._staWasUp) { this._staWasUp = false; this.stop({byUser: false}); return; }
        }
        if (!this.active) this._staWasUp = false;
        if (this.phone?.device?.connected && dual && this.clients === 0 && !this.active) this._userStopped = false;

        const resting = GLib.get_monotonic_time() < this._restUntil;
        const want = this.auto && !this.active && !this.busy && this.nm.wireless_enabled && !this._userStopped &&
            !resting && !BUSY.includes(st) && (dual ? !this._phoneElsewhere : !wifiJoined && !wired);
        if (want && !this._startTimer) {
            this._startTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, START_AFTER, () => {
                this._startTimer = 0;
                if (this._wantNow()) this.start();
                return GLib.SOURCE_REMOVE;
            });
        } else if (!want && this._startTimer) {
            GLib.source_remove(this._startTimer);
            this._startTimer = 0;
        }

        if (this.active && !this._checkTimer) {
            this._idleSince = GLib.get_monotonic_time();
            this._checkClients();
            // Also notices the helper's group going away (it has no signal of its own).
            this._checkTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => { this._sync(); this._checkClients(); return GLib.SOURCE_CONTINUE; });
        } else if (!this.active && this._checkTimer) {
            GLib.source_remove(this._checkTimer);
            this._checkTimer = 0;
            this.clients = 0;
        }
        if (this.active && !this.psk) this._loadSecret();
        this.emit('changed');
    }

    _wantNow() {
        const st = this.dev?.get_state();
        if (!this.auto || this.active || this.busy || this._userStopped || !this.nm.wireless_enabled || BUSY.includes(st)) return false;
        if (this.dual) return !this._phoneElsewhere;
        return st !== NM.DeviceState.ACTIVATED;
    }

    /** Devices on the hotspot = complete ARP entries on its interface. */
    _checkClients() {
        const iface = this.apIface;
        const arp = (readText('/proc/net/arp') ?? '').split('\n').slice(1).map(l => l.trim().split(/\s+/));
        this.clients = iface ? arp.filter(f => f.length >= 6 && f[5] === iface && f[2] === '0x2').length : 0;
        if (this.clients) this._idleSince = GLib.get_monotonic_time();
        else if (this.auto && this.active && !this.busy) {
            const idle = (GLib.get_monotonic_time() - this._idleSince) / 1e6;
            if (this.dual && idle > IDLE_DUAL) {
                // Nobody came: rest a while, then Auto tries again.
                this._restUntil = GLib.get_monotonic_time() + REST_DUAL * 1e6;
                this.stop({byUser: false});
                this._restTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REST_DUAL + 1, () => {
                    this._restTimer = 0;
                    this._sync();
                    return GLib.SOURCE_REMOVE;
                });
            } else if (!this.dual && idle > IDLE_SINGLE) {
                // Single radio: step down so NetworkManager can rejoin a known network; _sync raises it again if none.
                this.stop({byUser: false});
            }
        }
        this.emit('changed');
    }

    /** Text for Android's "scan to join". */
    get joinText() { return this.psk ? wifiQrText(this.ssid, this.psk) : ''; }

    destroy() {
        for (const t of [this._startTimer, this._checkTimer, this._hookTimer, this._restTimer]) if (t) GLib.source_remove(t);
        this._startTimer = this._checkTimer = this._hookTimer = this._restTimer = 0;
        this.nm?.disconnectObject(this);
        this.dev?.disconnectObject(this);
        this.phone?.disconnectObject(this);
    }
}
