import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {readText} from './util.js';

const async = fn => fn().catch(e => console.debug(`caelestia-gnome: ${e.message}`));

const sysProxy = (bus, name, path, iface) => new Promise((resolve, reject) =>
    Gio.DBusProxy.new(bus, Gio.DBusProxyFlags.NONE, null, name, path, iface, null, (o, r) => {
        try { resolve(Gio.DBusProxy.new_finish(r)); } catch (e) { reject(e); }
    }));

function setProp(proxy, iface, prop, variant) {
    proxy.get_connection().call(proxy.get_name(), proxy.get_object_path(),
        'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', [iface, prop, variant]),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

/**
 * The live system state the bar, sidebar and OSD read. Emits 'changed' whenever any of it moves;
 * each value is usable (just empty) before its async source has answered.
 */
export class Services extends Signals.EventEmitter {
    constructor() {
        super();
        this.battery = null;     // {level, charging}
        this.net = {icon: 'signal_wifi_off', name: 'Offline', wifi: false};
        this.bluetoothOn = false;
        this.profile = null;
        this.idleInhibited = false;
        this._dead = false;

        this._mixer = getMixerControl();
        this._mixer.connectObject('default-sink-changed', () => this._watchStreams(),
            'default-source-changed', () => this._watchStreams(),
            'state-changed', () => this._watchStreams(), this);
        this._watchStreams();

        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._bg.connectObject('changed::show-banners', () => this._notify(), this);
        this._night = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._night.connectObject('changed::night-light-enabled', () => this._notify(), this);

        async(() => this._initBattery());
        async(() => this._initRfkill());
        async(() => this._initProfiles());
        this._initNetwork();

        const bm = Main.brightnessManager;
        bm?.connectObject('changed', () => this._watchBrightness(), this);
        this._watchBrightness();
    }

    _notify() {
        if (!this._dead) this.emit('changed');
    }

    _watchStreams() {
        for (const [key, stream] of [['_sink', this._mixer.get_default_sink()], ['_source', this._mixer.get_default_source()]]) {
            this[key]?.disconnectObject(this);
            this[key] = stream;
            stream?.connectObject('notify::volume', () => this._notify(), 'notify::is-muted', () => this._notify(), this);
        }
        this._notify();
    }

    _watchBrightness() {
        const s = Main.brightnessManager?.globalScale;
        if (s === this._scale) return;
        this._scale?.disconnectObject(this);
        this._scale = s ?? null;
        s?.connectObject('notify::value', () => this._notify(), this);
        this._notify();
    }

    get volume() {
        const s = this._sink;
        return s ? s.volume / this._mixer.get_vol_max_norm() : 0;
    }

    set volume(v) {
        const s = this._sink;
        if (!s) return;
        s.volume = Math.max(0, Math.min(1, v)) * this._mixer.get_vol_max_norm();
        if (s.is_muted && v > 0) s.change_is_muted(false);
        s.push_volume();
    }

    get muted() { return this._sink?.is_muted ?? false; }
    toggleMute() { this._sink?.change_is_muted(!this.muted); }
    get micMuted() { return this._source?.is_muted ?? true; }
    toggleMic() { this._source?.change_is_muted(!this.micMuted); }
    get brightness() { return this._scale?.value ?? null; }
    set brightness(v) { if (this._scale) this._scale.value = Math.max(0, Math.min(1, v)); }

    get sinkName() { return this._sink?.description ?? 'No output'; }

    get volumeIcon() {
        const v = this.volume;
        return this.muted || v <= 0 ? 'volume_off' : v < .34 ? 'volume_mute' : v < .67 ? 'volume_down' : 'volume_up';
    }

    get dnd() { return !this._bg.get_boolean('show-banners'); }
    set dnd(on) { this._bg.set_boolean('show-banners', !on); }
    get nightLight() { return this._night.get_boolean('night-light-enabled'); }
    set nightLight(on) { this._night.set_boolean('night-light-enabled', on); }

    async _initBattery() {
        const p = await sysProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device');
        if (this._dead) return;
        this._battery = p;
        const read = () => {
            if (!p.get_cached_property('IsPresent')?.unpack()) { this.battery = null; return; }
            this.battery = {
                level: p.get_cached_property('Percentage').unpack(),
                charging: [1, 4].includes(p.get_cached_property('State').unpack()),
                full: p.get_cached_property('State').unpack() === 4,
                toEmpty: p.get_cached_property('TimeToEmpty')?.unpack() ?? 0,
                toFull: p.get_cached_property('TimeToFull')?.unpack() ?? 0,
                watts: p.get_cached_property('EnergyRate')?.unpack() ?? 0,
            };
        };
        p.connectObject('g-properties-changed', () => { read(); this._notify(); }, this);
        read();
        this._notify();
    }

    get batteryIcon() {
        const b = this.battery;
        if (!b) return null;
        if (b.charging) return 'battery_charging_full';
        return b.level >= 95 ? 'battery_full' : `battery_${Math.min(6, Math.floor(b.level / 100 * 7))}_bar`;
    }

    async _initRfkill() {
        const p = await sysProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
            '/org/gnome/SettingsDaemon/Rfkill', 'org.gnome.SettingsDaemon.Rfkill');
        if (this._dead) return;
        this._rfkill = p;
        p.connectObject('g-properties-changed', () => this._notify(), this);
        this._notify();
    }

    get btAvailable() { return this._rfkill?.get_cached_property('BluetoothHasAirplaneMode')?.unpack() ?? false; }
    get btOn() { return this.btAvailable && !this._rfkill.get_cached_property('BluetoothAirplaneMode')?.unpack(); }
    set btOn(on) { setProp(this._rfkill, 'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode', GLib.Variant.new_boolean(!on)); }
    get airplane() { return this._rfkill?.get_cached_property('AirplaneMode')?.unpack() ?? false; }
    set airplane(on) { setProp(this._rfkill, 'org.gnome.SettingsDaemon.Rfkill', 'AirplaneMode', GLib.Variant.new_boolean(on)); }

    async _initProfiles() {
        const p = await sysProxy(Gio.DBus.system, 'org.freedesktop.UPower.PowerProfiles',
            '/org/freedesktop/UPower/PowerProfiles', 'org.freedesktop.UPower.PowerProfiles');
        if (this._dead) return;
        this._profiles = p;
        const read = () => { this.profile = p.get_cached_property('ActiveProfile')?.unpack() ?? null; };
        p.connectObject('g-properties-changed', () => { read(); this._notify(); }, this);
        read();
        this._notify();
    }

    setProfile(name) {
        if (this._profiles) setProp(this._profiles, 'org.freedesktop.UPower.PowerProfiles', 'ActiveProfile', GLib.Variant.new_string(name));
    }

    cycleProfile() {
        const order = ['power-saver', 'balanced', 'performance'];
        this.setProfile(order[(order.indexOf(this.profile) + 1) % 3]);
    }

    _initNetwork() {
        NM.Client.new_async(null, (o, r) => {
            try { this._nm = NM.Client.new_finish(r); } catch (e) { console.debug(e); return; }
            if (this._dead) { this._nm = null; return; }
            this._nm.connectObject('notify::primary-connection', () => this._syncNet(),
                'notify::wireless-enabled', () => this._syncNet(), 'notify::state', () => this._syncNet(),
                'notify::active-connections', () => this._syncNet(), this);
            // NetworkManager reports connection changes itself; this only refreshes Wi-Fi signal bars.
            this._netTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
                this._syncNet();
                return GLib.SOURCE_CONTINUE;
            });
            this._syncNet();
        });
    }

    /** The NetworkManager client, for the Wi-Fi list in the network popout. */
    get nmClient() { return this._nm ?? null; }

    _syncNet() {
        const c = this._nm?.primary_connection;
        const wifiOn = this._nm?.wireless_enabled ?? false;
        let n = {icon: wifiOn ? 'signal_wifi_0_bar' : 'signal_wifi_off', name: 'Offline'};
        const link = this._nm?.get_active_connections().find(a => a.get_id() === 'Caelestia Phone Link');
        if (!c && link) n = {icon: 'wifi_tethering', name: 'Phone Link hotspot', kind: 'Hotspot'};
        if (c) {
            const dev = c.get_devices()[0];
            if (dev instanceof NM.DeviceWifi) {
                const ap = dev.active_access_point;
                const bars = Math.min(4, Math.floor((ap?.strength ?? 0) / 20));
                n = {icon: bars ? `network_wifi${bars === 4 ? '' : `_${bars}_bar`}` : 'signal_wifi_0_bar', name: c.id,
                    kind: 'Wi-Fi', strength: ap?.strength ?? 0};
            } else {
                n = {icon: 'lan', name: c.id, kind: 'Wired'};
            }
        }
        this.net = {...n, wifi: wifiOn};
        this._notify();
    }

    set wifi(on) { this._nm?.dbus_set_property?.('/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(on), -1, null, null); }

    toggleIdleInhibit() {
        const bus = Gio.DBus.session, sm = 'org.gnome.SessionManager';
        if (this._cookie) {
            bus.call(sm, '/org/gnome/SessionManager', sm, 'Uninhibit', new GLib.Variant('(u)', [this._cookie]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
            this._cookie = 0;
            this.idleInhibited = false;
            this._notify();
            return;
        }
        bus.call(sm, '/org/gnome/SessionManager', sm, 'Inhibit',
            new GLib.Variant('(susu)', ['caelestia-gnome', 0, 'Keep awake toggle', 8]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (c, r) => {
                try {
                    [this._cookie] = c.call_finish(r).deepUnpack();
                    this.idleInhibited = true;
                } catch (e) { console.debug(e); }
                this._notify();
            });
    }

    destroy() {
        this._dead = true;
        if (this._cookie) this.toggleIdleInhibit();
        if (this._netTimer) GLib.source_remove(this._netTimer);
        for (const o of [this._mixer, this._sink, this._source, this._scale, this._bg, this._night,
            this._battery, this._rfkill, this._profiles, this._nm, Main.brightnessManager])
            o?.disconnectObject(this);
        this._nm = null;
    }
}

/** CPU, memory, disk, network and temperature, sampled from /proc and /sys. */
export class Stats {
    constructor() {
        Object.assign(this, {cpu: 0, mem: 0, memUsed: 0, memTotal: 0, disk: 0, diskUsed: 0, diskTotal: 0, temp: null, down: 0, up: 0, uptime: 0});
        this._zone = this._findTemp();
        this.sample();
    }

    _findTemp() {
        let best = null;
        for (let i = 0; i < 16; i++) {
            const dir = `/sys/class/hwmon/hwmon${i}`;
            const name = readText(`${dir}/name`)?.trim();
            if (!name) continue;
            if (['coretemp', 'k10temp', 'zenpower'].includes(name)) return `${dir}/temp1_input`;
            if (name === 'acpitz') best = `${dir}/temp1_input`;
        }
        return best;
    }

    /** The next rates cover only the time after this, not the idle stretch since the last look. */
    resetRates() { this._at = 0; }

    sample() {
        const cpu = readText('/proc/stat')?.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        if (cpu) {
            const idle = cpu[3] + cpu[4], total = cpu.reduce((a, b) => a + b, 0);
            if (this._total) this.cpu = 1 - (idle - this._idle) / Math.max(1, total - this._total);
            this._idle = idle;
            this._total = total;
        }
        const mem = Object.fromEntries((readText('/proc/meminfo') ?? '').split('\n')
            .map(l => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map(m => [m[1], Number(m[2])]));
        if (mem.MemTotal) {
            this.memTotal = mem.MemTotal * 1024;
            this.memUsed = (mem.MemTotal - mem.MemAvailable) * 1024;
            this.mem = this.memUsed / this.memTotal;
        }
        try {
            const i = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
            this.diskTotal = i.get_attribute_uint64('filesystem::size');
            this.diskUsed = this.diskTotal - i.get_attribute_uint64('filesystem::free');
            this.disk = this.diskUsed / this.diskTotal;
        } catch {}
        const t = this._zone && Number(readText(this._zone));
        if (t) this.temp = t / 1000;
        let rx = 0, tx = 0;
        for (const l of (readText('/proc/net/dev') ?? '').split('\n').slice(2)) {
            const f = l.trim().split(/[:\s]+/);
            if (f.length < 10 || f[0] === 'lo') continue;
            rx += Number(f[1]);
            tx += Number(f[9]);
        }
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._at) {
            this.down = Math.max(0, rx - this._rx) / (now - this._at);
            this.up = Math.max(0, tx - this._tx) / (now - this._at);
        }
        Object.assign(this, {_rx: rx, _tx: tx, _at: now});
        this.uptime = Number(readText('/proc/uptime')?.split(' ')[0] ?? 0);
    }
}

export function bytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
