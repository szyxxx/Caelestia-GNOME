import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Icon, button, hbox, label, vbox} from './ui.js';
import {readText} from './util.js';

const DATA = GLib.build_filenamev([GLib.get_user_data_dir(), 'caelestia-rice']);
const COLS = 5;


const CHOICES = [
    {key: 'mode', title: 'Mode', flag: '--mode', items: [['dark', 'Dark', 'dark_mode'], ['light', 'Light', 'light_mode']]},
    {key: 'motion', title: 'Motion', flag: '--motion', items: [['fluid', 'Fluid', 'water'], ['expressive', 'Bouncy', 'animation'], ['calm', 'Calm', 'air'], ['snappy', 'Quick', 'bolt'], ['off', 'Off', 'block']]},
    {key: 'corners', title: 'Corners', flag: '--corners', items: [['round', 'Round', 'rounded_corner'], ['soft', 'Soft', 'crop_square'], ['sharp', 'Sharp', 'square']]},
    {key: 'border', title: 'Frame', flag: '--border', items: [['normal', 'Normal', 'border_outer'], ['thin', 'Thin', 'border_clear']]},
];

/** Everything needed to re-rice from one place: rice profiles, colours, shape, motion, wallpaper. */
export class ThemePage {
    constructor(shell) {
        this.shell = shell;
        this.actor = vbox('cae-themes', {width: 1060});
        const scroll = this._scroll = new St.ScrollView({style_class: 'cae-themes-scroll', height: 500, hscrollbar_policy: St.PolicyType.NEVER, x_expand: true});
        this._inner = vbox('cae-themes-inner', {x_expand: true});
        scroll.child = this._inner;
        this.actor.add_child(scroll);
        this._key = null;
    }

    parts() { return this._inner.get_children(); }

    _catalog() {
        try { return JSON.parse(readText(`${DATA}/themes.json`) ?? 'null'); } catch { return null; }
    }

    /** Called when the page is shown and after every change, so it always reflects the real state. */
    refresh() {
        const c = this._catalog();
        const raw = JSON.stringify(c);
        if (raw === this._key) return;
        this._key = raw;
        this._inner.destroy_all_children();
        if (!c) {
            this._inner.add_child(label('Building the theme list…', 'cae-dim'));
            this.shell.applyTheme([]);
            return;
        }
        this._profiles(c);
        this._controls(c);
        this._walls(c);
        this._palettes(c);
    }

    _section(title, trailing = null) {
        const row = hbox('cae-theme-head');
        row.add_child(label(title, 'cae-theme-title', {x_expand: true}));
        if (trailing) row.add_child(trailing);
        this._inner.add_child(row);
    }

    _grid() {
        const g = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 10, row_spacing: 10}), x_expand: true});
        this._inner.add_child(g);
        return g;
    }

    _swatch(colors) {
        const row = hbox('cae-swatch-row', {x_expand: true});
        colors.forEach((c, i) => {
            const side = i === 0 ? 'border-radius: 10px 0 0 10px;' : i === colors.length - 1 ? 'border-radius: 0 10px 10px 0;' : '';
            row.add_child(new St.Widget({x_expand: true, height: 34, style: `background-color: ${c}; ${side}`}));
        });
        return row;
    }

    _card(name, colors, active, onClick, sub = '') {
        const box = vbox('cae-theme-card-inner', {x_expand: true});
        box.add_child(this._swatch(colors));
        const row = hbox('', {x_expand: true});
        row.add_child(label(name, 'cae-theme-name', {x_expand: true}));
        if (active) row.add_child(new Icon('check_circle', 18, {fill: true, style_class: 'cae-primary'}));
        box.add_child(row);
        if (sub) box.add_child(label(sub, 'cae-theme-sub'));
        const b = button(box, `cae-theme-card${active ? ' active' : ''}`, onClick, {x_expand: true});
        return b;
    }

    _profiles(c) {
        const entry = new St.Entry({style_class: 'cae-theme-entry', hint_text: 'Name this rice…', can_focus: true, width: 170});
        const save = () => {
            const name = entry.text.trim();
            if (name) this.shell.applyTheme(['--save', name]);
            entry.text = '';
        };
        entry.clutter_text.connect('activate', save);
        const tail = hbox('cae-theme-save');
        tail.add_child(entry);
        tail.add_child(button(new Icon('save', 20), 'cae-flat', save));
        this._section('Rice profiles', tail);
        const g = this._grid();
        c.profiles.forEach((p, i) => {
            const sub = `${p.motion} · ${p.corners}${p.mode === 'light' ? ' · light' : ''}`;
            const card = this._card(p.name, p.swatch, p.id === c.current.profile, () => this.shell.applyTheme(['--profile', p.id]), sub);
            if (p.custom) {
                card.connect('button-press-event', (a, e) => {
                    if (e.get_button() !== 3) return Clutter.EVENT_PROPAGATE;
                    this.shell.applyTheme(['--delete', p.id]);
                    return Clutter.EVENT_STOP;
                });
            }
            g.layout_manager.attach(card, i % COLS, Math.floor(i / COLS), 1, 1);
        });
    }

    _palettes(c) {
        this._section('Colours');
        const g = this._grid();
        const dyn = c.current.palette === 'dynamic';
        c.palettes.forEach((p, i) => {
            g.layout_manager.attach(this._card(p.name, p.swatch, p.id === c.current.palette, () => this.shell.applyTheme(['--palette', p.id])), i % COLS, Math.floor(i / COLS), 1, 1);
        });
        if (dyn) this._chips({key: 'variant', title: 'Wallpaper colour style', flag: '--variant', items: c.variants.map(v => [v.id, v.name, 'colors'])}, c.current);
    }

    _chips(def, current) {
        const row = hbox('cae-theme-chips');
        row.add_child(label(def.title, 'cae-theme-chip-title', {width: 170}));
        for (const [id, name, ic] of def.items) {
            const box = hbox('cae-chip-inner', {x_align: Clutter.ActorAlign.CENTER});
            box.add_child(new Icon(ic, 18));
            box.add_child(label(name, 'cae-chip-label'));
            const b = button(box, 'cae-chip', () => this.shell.applyTheme([def.flag, id]));
            if (current[def.key] === id) b.add_style_pseudo_class('checked');
            row.add_child(b);
        }
        this._inner.add_child(row);
    }

    _controls(c) {
        this._section('Style');
        for (const def of CHOICES) this._chips(def, c.current);
    }

    _walls(c) {
        if (!c.wallpapers.length) return;
        this._section('Wallpaper');
        const row = hbox('cae-wall-row');
        for (const w of c.wallpapers) {
            const art = new St.Widget({width: 176, height: 110, style_class: 'cae-wall-thumb', style: `background-image: url("file://${w.thumb}"); background-size: cover;`});
            const b = button(art, `cae-wall${w.path === c.current.wallpaper ? ' active' : ''}`, () => this.shell.setWallpaper(w.path));
            row.add_child(b);
        }
        this._inner.add_child(row);
    }

    destroy() {}
}

