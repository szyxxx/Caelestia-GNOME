import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BAR_WIDTH, BORDER} from './ui.js';

const APP_ID = 'dev.caelestia.ShareShelf';
const APP_PATH = '/dev/caelestia/ShareShelf';
const ZONE_TOP = 64;   // px from the top edge (the notch) that call the shelf during a drag
const TEST_FLAG = `${GLib.get_user_cache_dir()}/caelestia-gnome/shelf-test`;

/**
 * Drag a file (or text) to the top edge or onto the bar, and a share shelf drops down under the notch:
 * every connected GSConnect device is a drop target.
 *
 * The shell sees a drag's path (Meta DnD position events) but cannot receive the drop, so the targets
 * live in a tiny GTK4 app (tools/shareshelf.py). It is started, hidden, when a drag begins, so it is
 * ready by the time the pointer reaches the top; the shell places its window under the notch, keeps it
 * above everything and on every workspace, and hides it when the drag ends without a drop on it.
 *
 * Power: nothing runs outside drags. The helper quits after 10 idle minutes.
 */
export class ShareShelf {
    constructor(extPath, phone = null) {
        this._script = `${extPath}/tools/shareshelf.py`;
        this._phone = phone;
        this._dnd = global.backend.get_dnd();
        this._shown = false;
        this._dragging = false;
        this._actions = null;
        // Positions come from Meta's DnD; the real end of a drag from the shell's xdnd handler
        // (dnd-leave also fires when the pointer merely crosses onto a window, like the shelf itself).
        this._dnd.connectObject('dnd-enter', () => this._begin(), 'dnd-position-change', (d, x, y) => this._moved(x, y), this);
        Main.xdndHandler.connectObject('drag-end', () => this._end(), this);
        global.display.connectObject('window-created', (d, w) => this._placeIfOurs(w), this);
    }

    _helperRunning() {
        try {
            const r = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'NameHasOwner', new GLib.Variant('(s)', [APP_ID]), null, Gio.DBusCallFlags.NONE, 500, null);
            return r.deepUnpack()[0];
        } catch { return false; }
    }

    /** Start the helper early (hidden) so the shelf appears without a delay. */
    _begin() {
        this._dragging = true;
        this._shown = false;
        if (this._helperRunning()) return;
        try {
            // Wayland only: with DISPLAY set, GTK's accessibility setup waits for an on-demand Xwayland
            // and the first window never maps.
            const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            l.unsetenv('DISPLAY');
            l.setenv('GDK_BACKEND', 'wayland', true);
            l.spawnv(['/usr/bin/python3', this._script]);
        } catch (e) { logError(e, 'share shelf'); }
    }

    _moved(x, y) {
        if (!this._dragging) this._begin();
        if (this._shown) return;
        const m = Main.layoutManager.primaryMonitor;
        if (!m) return;
        const nearTop = y < m.y + ZONE_TOP;
        const onBar = x < m.x + BAR_WIDTH + 8;
        // Only GSConnect sends: with no phone connected there is nothing to offer, so no shelf.
        // (The sandbox tests use a flag file for a stand-in target.)
        const phoneUp = !!this._phone?.device?.connected || GLib.file_test(TEST_FLAG, GLib.FileTest.EXISTS);
        if ((nearTop || onBar) && phoneUp) this._show();
    }

    _action(name) {
        // The helper may still be starting: try for a moment.
        let tries = 0;
        const go = () => {
            if (!this._helperRunning()) {
                if (++tries < 20) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { go(); return GLib.SOURCE_REMOVE; });
                return;
            }
            Gio.DBus.session.call(APP_ID, APP_PATH, 'org.gtk.Actions', 'Activate',
                new GLib.Variant('(sava{sv})', [name, [], {}]), null, Gio.DBusCallFlags.NONE, 2000, null, null);
        };
        go();
    }

    _show() {
        this._shown = true;
        this._action('show');
    }

    _end() {
        if (!this._dragging) return;
        this._dragging = false;
        if (this._shown) this._action('drag-ended');
        this._shown = false;
    }

    _isOurs(w) {
        return w?.get_gtk_application_id?.() === APP_ID || w?.get_wm_class() === APP_ID;
    }

    /** Under the notch, centred, above everything, on every workspace. */
    _placeIfOurs(w) {
        // The app id arrives with the first commit; look again once the window is shown.
        const place = () => {
            if (!this._isOurs(w)) return false;
            const m = Main.layoutManager.primaryMonitor;
            const r = w.get_frame_rect();
            w.make_above();
            w.stick();
            w.move_frame(true, Math.round(m.x + BAR_WIDTH / 2 + (m.width - r.width) / 2), m.y + BORDER);
            return true;
        };
        if (place()) return;
        const id = w.connect('shown', () => { w.disconnect(id); place(); });
    }

    destroy() {
        this._dnd.disconnectObject(this);
        Main.xdndHandler.disconnectObject(this);
        global.display.disconnectObject(this);
        if (this._helperRunning()) this._action('quit');
    }
}
