import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadConfig, saveConfig} from './util.js';

/**
 * The paired phone, read from GSConnect (KDE Connect for GNOME) over D-Bus.
 *
 * GSConnect does the work: pairing, encryption, clipboard, file transfer, notifications. This only
 * mirrors its first paired device for the Caelestia bar, where GNOME's own panel (which normally
 * holds GSConnect's menu) is hidden. Everything is signal-driven; nothing here polls.
 */

const NAME = 'org.gnome.Shell.Extensions.GSConnect';
const ROOT = '/org/gnome/Shell/Extensions/GSConnect';
const DEVICE = 'org.gnome.Shell.Extensions.GSConnect.Device';
const GSC_SCHEMAS = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'gsconnect@andyholmes.github.io', 'schemas']);
const KDE_SFTP = /^sftp:\/\/[^/]+:17(39|[4-5]\d|6[0-4])\//;   // KDE Connect's SFTP port range 1739-1764

export class Phone extends Signals.EventEmitter {
    constructor() {
        super();
        this.device = null;      // {path, name, connected, paired, icon, actions}
        this.battery = null;     // {charging, level}
        this._dead = false;
        Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SESSION, Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
            NAME, ROOT, null, null, (o, res) => {
                try { this._om = Gio.DBusObjectManagerClient.new_for_bus_finish(res); } catch (e) { console.debug(`caelestia-gnome phone: ${e.message}`); return; }
                if (this._dead) { this._om = null; return; }
                this._om.connectObject('object-added', () => this._pick(), 'object-removed', () => this._pick(),
                    'interface-proxy-properties-changed', () => this._pick(), 'notify::name-owner', () => this._pick(), this);
                this._pick();
            });
    }

    /** GSConnect is installed and running. */
    get available() { return !!this._om?.name_owner; }

    /** First paired device, preferring one that is connected now. */
    _pick() {
        if (this._dead) return;
        const devs = (this._om?.get_objects() ?? []).map(o => o.get_interface(DEVICE)).filter(Boolean).map(p => ({
            path: p.get_object_path(),
            name: p.get_cached_property('Name')?.unpack() ?? 'Phone',
            connected: p.get_cached_property('Connected')?.unpack() ?? false,
            paired: p.get_cached_property('Paired')?.unpack() ?? false,
            icon: p.get_cached_property('IconName')?.unpack() ?? '',
        })).filter(d => d.paired);
        devs.sort((a, b) => b.connected - a.connected);
        const d = devs[0] ?? null;
        if (d?.path !== this.device?.path) this._watch(d);
        else if (d) Object.assign(this.device, {name: d.name, connected: d.connected, icon: d.icon});
        else this.device = null;
        this.emit('changed');
    }

    _watch(d) {
        this._actions?.disconnectObject(this);
        this._actions = null;
        this.device = d;
        this.battery = null;
        if (!d) return;
        this._actions = Gio.DBusActionGroup.get(Gio.DBus.session, NAME, d.path);
        this._actions.connectObject('action-added', () => this._sync(), 'action-removed', () => this._sync(),
            'action-enabled-changed', () => this._sync(), 'action-state-changed', () => this._sync(), this);
        // A DBusActionGroup only fetches its actions once someone asks for them.
        this._actions.list_actions();
        this._enableClipboard(d.path);
    }

    _sync() {
        const a = this._actions;
        if (!a) return;
        const st = a.has_action('battery') ? a.get_action_state('battery')?.deepUnpack() : null;
        this.battery = st && st[2] >= 0 ? {charging: st[0], level: st[2]} : null;
        this.emit('changed');
    }

    can(action) { return !!this._actions?.has_action(action) && this._actions.get_action_enabled(action); }

    activate(action, param = null) {
        if (this.can(action)) this._actions.activate_action(action, param);
    }

    /** GSConnect ships clipboard sync off; turn both directions on once per device, then leave it to you. */
    _enableClipboard(path) {
        try {
            const id = path.split('/').pop();
            const done = loadConfig().phoneClipboard ?? [];
            if (done.includes(id)) return;
            const src = Gio.SettingsSchemaSource.new_from_directory(GSC_SCHEMAS, Gio.SettingsSchemaSource.get_default(), false);
            const schema = src.lookup('org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard', false);
            if (!schema) return;
            const s = new Gio.Settings({settings_schema: schema, path: `/org/gnome/shell/extensions/gsconnect/device/${id}/plugin/clipboard/`});
            s.set_boolean('send-content', true);
            s.set_boolean('receive-content', true);
            saveConfig({phoneClipboard: [...done, id]});
        } catch (e) { console.debug(`caelestia-gnome phone clipboard: ${e.message}`); }
    }

    /** Mount the phone's storage and open it in Files (mounting first if needed). */
    browse() {
        const open = m => Gio.AppInfo.launch_default_for_uri_async(m.get_root().get_uri(), null, null, null);
        const vm = Gio.VolumeMonitor.get();
        const have = vm.get_mounts().find(m => KDE_SFTP.test(m.get_root().get_uri()));
        if (have) { open(have); return; }
        if (!this.can('mount')) return;
        const id = vm.connect('mount-added', (v, m) => {
            if (!KDE_SFTP.test(m.get_root().get_uri())) return;
            vm.disconnect(id);
            GLib.source_remove(guard);
            open(m);
        });
        const guard = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => { vm.disconnect(id); return GLib.SOURCE_REMOVE; });
        this.activate('mount');
    }

    /** GSConnect's own window, where phones are found and paired. */
    openSettings() {
        if (this.available) {
            Gio.DBus.session.call(NAME, ROOT, 'org.gtk.Actions', 'Activate',
                new GLib.Variant('(sava{sv})', ['preferences', [], {}]), null, Gio.DBusCallFlags.NONE, -1, null, null);
            return;
        }
        try { Gio.Subprocess.new(['gnome-extensions', 'prefs', 'gsconnect@andyholmes.github.io'], Gio.SubprocessFlags.NONE); } catch (e) { console.debug(e.message); }
    }

    destroy() {
        this._dead = true;
        this._actions?.disconnectObject(this);
        this._om?.disconnectObject(this);
        this._actions = this._om = null;
    }
}
