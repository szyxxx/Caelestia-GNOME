#!/usr/bin/python3
"""Caelestia share shelf: the drop targets that appear under the notch while you drag a file.

GNOME Shell can see a drag move across the screen but cannot receive what is dropped; only a client
window can. So the shell starts this small GTK4 app (hidden), shows it when a drag reaches the top edge
or the bar, and places it under the notch. Each tile is a drop target:

  phone (GSConnect)   files -> shareFile, links -> shareUri, text -> shareText

Controlled over D-Bus as a GApplication (dev.caelestia.ShareShelf): actions "show", "drag-ended", "quit".
Quits by itself after 10 idle minutes. Colours come from Caelestia's scheme.json.
"""
import json, os, sys
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
from gi.repository import Gdk, Gio, GLib, GObject, Gtk

APP_ID = 'dev.caelestia.ShareShelf'
GSC = 'org.gnome.Shell.Extensions.GSConnect'
GSC_PATH = '/org/gnome/Shell/Extensions/GSConnect'
IDLE_QUIT = 600
SCHEME = os.path.expanduser('~/.local/share/caelestia-rice/scheme.json')
TEST_FLAG = os.path.expanduser('~/.cache/caelestia-gnome/shelf-test')


def colours():
    c = {'surface': '#131313', 'surfaceContainer': '#1f1f1f', 'surfaceContainerHigh': '#2a2a2a',
         'surfaceContainerHighest': '#353535', 'onSurface': '#e2e2e2', 'onSurfaceVariant': '#c6c6c6',
         'primary': '#c6c6c6', 'onPrimary': '#303030', 'outlineVariant': '#474747'}
    try:
        c.update(json.load(open(SCHEME))['colors'])
    except (OSError, ValueError, KeyError):
        pass
    return c


def css():
    c = colours()
    return f"""
window.shelf {{ background: transparent; }}
.island {{ background: {c['surface']}; border-radius: 0 0 28px 28px; padding: 10px 14px 14px; }}
.hint {{ color: {c['onSurfaceVariant']}; font-size: 12px; margin-bottom: 8px; }}
.tile {{ background: {c['surfaceContainer']}; border-radius: 20px; padding: 12px 10px; min-width: 104px;
        transition: background 150ms, transform 150ms; }}
.tile image {{ color: {c['onSurface']}; }}
.tile .name {{ color: {c['onSurface']}; font-weight: 600; font-size: 13px; }}
.tile .sub {{ color: {c['onSurfaceVariant']}; font-size: 11px; }}
.tile.over {{ background: {c['primary']}; }}
.tile.over image, .tile.over .name, .tile.over .sub {{ color: {c['onPrimary']}; }}
.tile.done {{ background: {c['surfaceContainerHighest']}; }}
"""


def bus():
    return Gio.bus_get_sync(Gio.BusType.SESSION, None)


def gsconnect_devices():
    """Connected, paired GSConnect devices: [(path, name, icon)]."""
    try:
        objs = bus().call_sync(GSC, GSC_PATH, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
                               None, None, Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()[0]
    except GLib.Error:
        return []
    out = []
    for path, ifaces in objs.items():
        d = ifaces.get(GSC + '.Device')
        if d and d.get('Connected') and d.get('Paired'):
            icon = 'phone-symbolic' if d.get('Type') in ('phone', 'smartphone') else 'computer-symbolic'
            out.append((path, d.get('Name', 'Phone'), icon))
    return out


def gtk_action(name, path, action, param):
    bus().call(name, path, 'org.gtk.Actions', 'Activate',
               GLib.Variant('(sava{sv})', (action, [param] if param is not None else [], {})),
               None, Gio.DBusCallFlags.NONE, 10000, None, None, None)


class Shelf(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.win = None
        self._hide_id = self._idle_id = 0
        self._busy = False
        for name, fn in (('show', self.on_show), ('drag-ended', self.on_drag_ended), ('quit', lambda *a: self.quit())):
            a = Gio.SimpleAction.new(name, None)
            a.connect('activate', fn)
            self.add_action(a)

    def do_activate(self):
        # Started by the shell at the beginning of a drag: stay resident and hidden until "show".
        self.hold()
        self._arm_idle()

    def _arm_idle(self):
        if self._idle_id:
            GLib.source_remove(self._idle_id)
        self._idle_id = GLib.timeout_add_seconds(IDLE_QUIT, lambda: (self.quit(), False)[1])

    # ---- window ----

    def _build(self):
        prov = Gtk.CssProvider()
        prov.load_from_string(css())
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        w = Gtk.ApplicationWindow(application=self, title='Caelestia Share', decorated=False, resizable=False)
        w.add_css_class('shelf')
        island = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        island.add_css_class('island')
        self.hint = Gtk.Label(label='Drop to share')
        self.hint.add_css_class('hint')
        island.append(self.hint)
        self.row = Gtk.Box(spacing=10, homogeneous=True)
        island.append(self.row)
        w.set_child(island)
        self.win = w

    def _tile(self, icon, name, sub, on_drop, accepts_text=False):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.add_css_class('tile')
        img = Gtk.Image.new_from_icon_name(icon)
        img.set_pixel_size(28)
        box.append(img)
        n = Gtk.Label(label=name, ellipsize=3, max_width_chars=14)
        n.add_css_class('name')
        box.append(n)
        s = Gtk.Label(label=sub)
        s.add_css_class('sub')
        box.append(s)
        t = Gtk.DropTarget.new(GObject.TYPE_NONE, Gdk.DragAction.COPY)
        t.set_gtypes([Gdk.FileList.__gtype__] + ([GObject.TYPE_STRING] if accepts_text else []))
        t.connect('enter', lambda *a: (box.add_css_class('over'), Gdk.DragAction.COPY)[1])
        t.connect('leave', lambda *a: box.remove_css_class('over'))

        def drop(target, value, x, y):
            box.remove_css_class('over')
            try:
                done = on_drop(value)
            except Exception as e:  # report on the tile, never crash the shelf
                print('shareshelf:', e, file=sys.stderr, flush=True)
                done = 'Failed'
            box.add_css_class('done')
            s.set_label(done)
            self._busy = True
            self.hint.set_label(f'{name}: {done}')
            self._schedule_hide(1400)
            return True
        t.connect('drop', drop)
        box.add_controller(t)
        return box

    def _targets(self):
        child = self.row.get_first_child()
        while child:
            nxt = child.get_next_sibling()
            self.row.remove(child)
            child = nxt
        for path, name, icon in gsconnect_devices():
            self.row.append(self._tile(icon, name, 'GSConnect', lambda v, p=path: self.send_gsconnect(p, v), True))
        # Test target for the sandbox tests only (exists only when this flag file does).
        if os.path.exists(TEST_FLAG):
            self.row.append(self._tile('document-save-symbolic', 'Test', 'sandbox', self.send_test, True))

    # ---- senders ----

    @staticmethod
    def _files(value):
        return [f for f in value.get_files()] if isinstance(value, Gdk.FileList) else []

    def send_gsconnect(self, path, value):
        if isinstance(value, str):
            text = value.strip()
            if text.startswith(('http://', 'https://')) and '\n' not in text:
                gtk_action(GSC, path, 'shareUri', GLib.Variant('s', text))
                return 'Link sent'
            gtk_action(GSC, path, 'shareText', GLib.Variant('s', text))
            return 'Text sent'
        files = self._files(value)
        for f in files:
            gtk_action(GSC, path, 'shareFile', GLib.Variant('(sb)', (f.get_uri(), False)))
        return f'Sending {len(files)} file{"s" * (len(files) != 1)}'

    def send_test(self, value):
        got = value if isinstance(value, str) else '\n'.join(f.get_uri() for f in self._files(value))
        with open(TEST_FLAG, 'w') as f:
            f.write(got)
        return 'Received'

    # ---- actions from the shell ----

    def on_show(self, *a):
        self._arm_idle()
        if self._hide_id:
            GLib.source_remove(self._hide_id)
            self._hide_id = 0
        if self.win is None:
            self._build()
        if not self.win.get_visible():
            self._busy = False
            self.hint.set_label('Drop to share')
            self._targets()
            if not self.row.get_first_child():
                self.hint.set_label('No phone connected (GSConnect)')
            self.win.set_visible(True)
        if os.path.exists(TEST_FLAG):
            names = []
            c = self.row.get_first_child()
            while c:
                names.append(c.get_first_child().get_next_sibling().get_label())
                c = c.get_next_sibling()
            with open(TEST_FLAG + '-tiles', 'w') as f:
                json.dump(names, f)

    def on_drag_ended(self, *a):
        # The drop (if it landed here) is handled first; otherwise just go away.
        if not self._busy:
            self._schedule_hide(250)

    def _schedule_hide(self, ms):
        if self._hide_id:
            GLib.source_remove(self._hide_id)

        def hide():
            self._hide_id = 0
            self._busy = False
            if self.win:
                self.win.set_visible(False)
            return False
        self._hide_id = GLib.timeout_add(ms, hide)


if __name__ == '__main__':
    if os.path.exists(TEST_FLAG):
        import faulthandler, signal
        faulthandler.register(signal.SIGUSR1, all_threads=True)
    sys.exit(Shelf().run(sys.argv[:1]))
