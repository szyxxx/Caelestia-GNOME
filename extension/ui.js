import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Spring, closeResponse, enter, ms, overshoots, reduced} from './motion.js';

// Token values from Caelestia's plugin/src/Caelestia/Config. Profiles can change them at runtime,
// and `export let` means every module sees the new value.
export let BORDER = 10;
export let ROUNDING = 25;
export const BAR_INNER = 40;
export let BAR_WIDTH = BAR_INNER + BORDER * 2;

export function setTokens({border = 10, rounding = 25} = {}) {
    BORDER = border;
    ROUNDING = rounding;
    BAR_WIDTH = BAR_INNER + BORDER * 2;
}

export const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

export function setSource(cr, hex, alpha = 1) {
    const [r, g, b] = hexRgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

export function label(text, style_class, props = {}) {
    return new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER, ...props});
}

/** A Material Symbols glyph, written as its ligature name (e.g. "wifi"). */
export const Icon = GObject.registerClass(
class CaelestiaIcon extends St.Label {
    _init(name, size = 20, {fill = false, style_class = '', ...props} = {}) {
        super._init({
            style_class: `cae-icon ${style_class}`,
            style: `font-size: ${size}px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            ...props,
        });
        this._size = size;
        this._fill = fill;
        this.setIcon(name);
    }

    setIcon(name, fill = this._fill) {
        this._fill = fill;
        this.clutter_text.set_markup(
            `<span font_desc="Material Symbols Rounded @FILL=${fill ? 1 : 0}">${name}</span>`);
    }
});

export function button(child, style_class, onClick, props = {}) {
    const b = new St.Button({style_class, child, can_focus: true, ...props});
    b.connect('clicked', () => onClick(b));
    // A small press-in, so every button answers the finger before anything else happens.
    b.set_pivot_point(.5, .5);
    b.connect('notify::pressed', () => {
        const down = b.pressed;
        b.ease({scale_x: down ? .94 : 1, scale_y: down ? .94 : 1, duration: ms(down ? 80 : 220), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    });
    return b;
}

export function iconButton(name, size, style_class, onClick, props = {}) {
    return button(new Icon(name, size, props.iconProps ?? {}), style_class, onClick, props.button ?? {});
}

export function vbox(style_class, props = {}) {
    return new St.BoxLayout({style_class, orientation: Clutter.Orientation.VERTICAL, ...props});
}

export function hbox(style_class, props = {}) {
    return new St.BoxLayout({style_class, ...props});
}

export function every(seconds, fn) {
    fn();
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        fn();
        return GLib.SOURCE_CONTINUE;
    });
    return () => GLib.source_remove(id);
}

/** Cairo progress ring, used by the media cover and the performance cards. */
export const Ring = GObject.registerClass(
class CaelestiaRing extends St.DrawingArea {
    _init(theme, size, {thickness = 8, track = 'surfaceContainerHigh', color = 'primary'} = {}) {
        super._init({width: size, height: size});
        Object.assign(this, {_theme: theme, _thick: thickness, _track: track, _color: color, value: 0});
        this._spring = new Spring(this, x => { this.value = x; this.queue_repaint(); }, {response: .7, damping: 1});
        this.connect('destroy', () => this._spring.destroy());
    }

    setValue(v, {animate = true} = {}) {
        v = Math.max(0, Math.min(1, v));
        if (Math.abs(v - this._spring.target) < .0005) return;
        if (animate) this._spring.to(v);
        else this._spring.set(v);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const k = w / this.width;
        const r = (Math.min(w, h) - this._thick * k) / 2;
        const start = Math.PI * 0.75, sweep = Math.PI * 1.5;
        cr.setLineCap(1);
        cr.setLineWidth(this._thick * k);
        setSource(cr, this._theme.colors[this._track]);
        cr.arc(w / 2, h / 2, r, start, start + sweep);
        cr.stroke();
        if (this.value > 0.002) {
            setSource(cr, this._theme.colors[this._color]);
            cr.arc(w / 2, h / 2, r, start, start + sweep * this.value);
            cr.stroke();
        }
        cr.$dispose();
    }
});

/** Pill slider. Vertical ones are Caelestia's OSD bars; horizontal ones sit in the sidebar. */
export const Slider = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_DOUBLE]}},
}, class CaelestiaSlider extends St.Widget {
    _init(iconName, {vertical = false, length = 150, thickness = 30} = {}) {
        super._init({
            style_class: 'cae-slider', reactive: true, track_hover: true,
            width: vertical ? thickness : -1, height: vertical ? length : thickness,
            x_expand: !vertical,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._vertical = vertical;
        this._thick = thickness;
        this.value = 0;
        this._shown = 0;
        this._glide = new Spring(this, x => { this._shown = x; this._sync(); }, {response: .22, damping: 1});
        this.connect('destroy', () => this._glide.destroy());
        this._fill = new St.Widget({style_class: 'cae-slider-fill'});
        this.icon = new Icon(iconName, 18, {fill: true, style_class: 'cae-slider-icon'});
        this.add_child(this._fill);
        this.add_child(this.icon);
        this.connect('notify::allocation', () => this._sync());
        this.connect('button-press-event', (a, e) => this._press(e));
        this.connect('touch-event', (a, e) => { this._point(e); return Clutter.EVENT_PROPAGATE; });
        this.connect('motion-event', (a, e) => {
            if (this._dragging) this._point(e);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('button-release-event', () => { this._dragging = false; return Clutter.EVENT_STOP; });
        this.connect('leave-event', (a, e) => {
            if (!(e.get_state() & Clutter.ModifierType.BUTTON1_MASK)) this._dragging = false;
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('scroll-event', (a, e) => {
            const d = e.get_scroll_direction();
            const step = d === Clutter.ScrollDirection.UP ? .05 : d === Clutter.ScrollDirection.DOWN ? -.05 : 0;
            if (step) this.emit('changed', Math.max(0, Math.min(1, this.value + step)));
            return Clutter.EVENT_STOP;
        });
    }

    _press(e) {
        this._dragging = true;
        this._point(e);
        return Clutter.EVENT_STOP;
    }

    _point(e) {
        const [ex, ey] = e.get_coords();
        const [ok, x, y] = this.transform_stage_point(ex, ey);
        if (!ok) return;
        const box = this.get_allocation_box();
        const span = this._vertical ? box.get_height() : box.get_width();
        const pos = this._vertical ? span - y : x;
        this.value = Math.max(0, Math.min(1, pos / span));
        this._glide.set(this.value);
        this.emit('changed', this.value);
    }

    setValue(v) {
        if (this._dragging) return;
        this.value = Math.max(0, Math.min(1, v));
        // A brand new slider has no size to animate within, so it simply starts at its value.
        if (this.has_allocation()) this._glide.to(this.value);
        else this._glide.set(this.value);
    }

    _sync() {
        if (!this.has_allocation()) return;
        const box = this.get_allocation_box();
        const W = box.get_width(), H = box.get_height(), t = this._thick;
        if (!W || !H) return;
        const [, iw] = this.icon.get_preferred_width(-1);
        const [, ih] = this.icon.get_preferred_height(-1);
        if (this._vertical) {
            const h = Math.max(t, H * this._shown);
            this._fill.set_position(0, H - h);
            this._fill.set_size(W, h);
            this.icon.set_position((W - iw) / 2, H - ih - (t - ih) / 2);
        } else {
            this._fill.set_position(0, 0);
            this._fill.set_size(Math.max(t, W * this._shown), H);
            this.icon.set_position((t - iw) / 2, (H - ih) / 2);
        }
    }
});

/** Square piece filled everywhere except a quarter circle: the concave "flare" and frame corners. */
export const Corner = GObject.registerClass(
class CaelestiaCorner extends St.DrawingArea {
    _init(theme, cx, cy, size = ROUNDING) {
        super._init({width: size, height: size, reactive: false});
        Object.assign(this, {_theme: theme, _cx: cx, _cy: cy});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        setSource(cr, this._theme.colors.surface);
        cr.rectangle(0, 0, w, h);
        cr.setFillRule(1);
        cr.newSubPath();
        cr.arc(this._cx * w, this._cy * h, w, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

/** How far a bouncy spring may travel past its rest position, so room is kept for it. */
const OVERSCAN = 40;
/** How far past a hover-opened panel the pointer may stray, and for how long, before it closes. */
const NEAR = 6;   // Forgiving enough for an unsteady hand; more leaves a panel stuck when the pointer stops nearby.
const LEAVE_DELAY = 320;

/**
 * Caelestia's signature surface: a panel that slides out of the screen border and stays fused to
 * it through concave flares. Built from a cheap rounded St body plus two small fixed flares, so
 * it can change size on every frame; painting the whole shape in Cairo could not keep up.
 *
 * Two springs drive it: `reveal` slides it in and out, `size` morphs it when its content changes.
 * Both keep their velocity when interrupted, so reversing mid-slide curves instead of stopping.
 */
export class Drawer {
    /**
     * @param shell owner: theme, drawers registry
     * @param edge 'top' | 'bottom' | 'right' | 'left'
     * @param content actor placed inside; it reports the drawer's size
     * @param opts.modal grab input and close on outside click / Escape
     * @param opts.full span the whole edge
     * @param opts.passive never take input, for displays that sit over windows
     */
    constructor(shell, edge, content, {modal = true, full = false, align = 0.5, passive = false} = {}) {
        Object.assign(this, {shell, edge, content, modal, full, align, isOpen: false});
        this._fixedWidth = content.natural_width_set ? content.natural_width : -1;
        this._over = modal ? OVERSCAN : 0;
        this._size = null;
        this.root = new St.Widget({
            style_class: 'cae-drawer', clip_to_allocation: true, visible: false, reactive: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.slider = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.body = new St.Widget({style_class: 'cae-drawer-body'});
        this.bleed = new St.Widget({style_class: 'cae-drawer-body'});
        this.slider.add_child(this.bleed);
        this.slider.add_child(this.body);
        this.slider.add_child(content);
        this.root.add_child(this.slider);
        this._makeFlares();
        if (modal) {
            this.backdrop = new St.Widget({reactive: true, visible: false, can_focus: true});
            // Presses on the panel bubble up here: St.Button does not consume them.
            this.backdrop.connect('button-press-event', (a, e) => {
                if (global.stage.get_event_actor(e) !== this.backdrop) return Clutter.EVENT_PROPAGATE;
                this.close();
                return Clutter.EVENT_STOP;
            });
            this.backdrop.connect('key-press-event', (a, e) => {
                if (e.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
                this.close();
                return Clutter.EVENT_STOP;
            });
            // Motion over the panel bubbles up here too, so this sees the pointer everywhere.
            this.backdrop.connect('motion-event', (a, e) => {
                this._watchPointer(e);
                return Clutter.EVENT_PROPAGATE;
            });
            // Someone typing into a panel is using it, wherever the pointer happens to be.
            this.backdrop.connect('captured-event', (a, e) => {
                // Only real typing counts: a lone Ctrl or a Cmd shortcut must not pin the panel open.
                if (e.type() === Clutter.EventType.KEY_PRESS && e.get_key_unicode() &&
                    !(e.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK)))
                    this._transient = false;
                return Clutter.EVENT_PROPAGATE;
            });
            // A modal grab only delivers input to the grabbed actor and its descendants,
            // so the panel has to live inside the backdrop or it can never be clicked.
            this.backdrop.add_child(this.root);
            Main.layoutManager.addChrome(this.backdrop);
        } else {
            // Nothing here is reactive, so a passive drawer lets clicks through to the window below.
            Main.layoutManager.addChrome(this.root, {trackFullscreen: passive});
        }
        this.reveal = new Spring(this.root, p => this._applyReveal(p));
        this.size = new Spring(this.root, t => this._applyMorph(t), {damping: 1, response: .42});
    }

    /** Rebuilt rather than resized when a profile changes the corner radius. */
    _makeFlares() {
        this._flares?.forEach(f => f.destroy());
        const pairs = {top: [[0, 1], [1, 1]], bottom: [[0, 0], [1, 0]], left: [[1, 0], [1, 1]],
            right: this.full ? [[0, 1], [0, 0]] : [[0, 0], [0, 1]]}[this.edge];
        this._flares = pairs.map(([cx, cy]) => {
            const c = new Corner(this.shell.theme, cx, cy);
            this.slider.insert_child_above(c, this.body);
            return c;
        });
        this._flareRadius = ROUNDING;
        // Setting a style parses it, so this happens once here and not on every frame of a morph.
        const F = ROUNDING;
        this.body.style = {
            top: `border-radius: 0 0 ${F}px ${F}px;`,
            bottom: `border-radius: ${F}px ${F}px 0 0;`,
            left: `border-radius: 0 ${F}px ${F}px 0;`,
            right: this.full ? 'border-radius: 0;' : `border-radius: ${F}px 0 0 ${F}px;`,
        }[this.edge];
    }

    repaint() { this._flares.forEach(f => f.queue_repaint()); }

    _measure() {
        const m = Main.layoutManager.primaryMonitor;
        const F = ROUNDING;
        const innerX = m.x + BAR_WIDTH, innerY = m.y + BORDER;
        const innerW = m.width - BAR_WIDTH - BORDER, innerH = m.height - BORDER * 2;
        // The last fit would shadow the preferred size, so clear it; a width the content
        // asked for itself (launcher, sidebar) is part of its design and stays.
        this.content.set_size(this._fixedWidth, -1);
        const [, natW] = this.content.get_preferred_width(-1);
        const [, natH] = this.content.get_preferred_height(natW);
        const horizontal = this.edge === 'right' || this.edge === 'left';
        const w = horizontal ? natW + F : natW + F * 2;
        const h = horizontal ? (this.full ? innerH : natH + F * 2) : natH;
        // The content keeps its target size from the start of a morph; the clip reveals it.
        this.content.set_size(natW, this.full ? h : natH);
        return {natW, natH, w, h, innerX, innerY, innerW, innerH};
    }

    /** Where a panel of this size sits. Separate from _measure because a morph calls it per frame. */
    _place(w, h, t) {
        const {innerX, innerY, innerW, innerH} = t;
        let x, y;
        if (this.edge === 'right') {
            x = innerX + innerW - w;
            y = this.full ? innerY : innerY + (innerH - h) * this.align;
        } else if (this.edge === 'left') {
            x = innerX;
            y = this.anchorY !== undefined
                ? Math.max(innerY, Math.min(innerY + innerH - h, this.anchorY - h / 2))
                : innerY + (innerH - h) * this.align;
        } else {
            x = innerX + (innerW - w) * this.align;
            y = this.edge === 'top' ? innerY : innerY + innerH - h;
        }
        return [x, y];
    }

    _applyGeometry(w, h, t) {
        const F = ROUNDING, O = this._over;
        const [x, y] = this._place(w, h, t);
        const edge = this.edge;
        // Room for overshoot is on the side facing away from the screen edge.
        const rootX = edge === 'right' ? x - O : x, rootY = edge === 'bottom' ? y - O : y;
        const rootW = edge === 'right' || edge === 'left' ? w + O : w;
        const rootH = edge === 'top' || edge === 'bottom' ? h + O : h;
        // Sub-pixel while moving so edges glide; whole pixels at rest so text stays crisp.
        const snap = this.size.moving && this.size.value < 1 ? v => v : Math.round;
        this.root.set_position(snap(rootX), snap(rootY));
        this.root.set_size(Math.ceil(rootW), Math.ceil(rootH));
        const sx = edge === 'right' ? O : 0, sy = edge === 'bottom' ? O : 0;
        this.slider.set_position(sx, sy);
        this.slider.set_size(Math.ceil(w), Math.ceil(h));
        const [a, b] = this._flares;
        if (edge === 'top' || edge === 'bottom') {
            this.body.set_position(F - 1, 0);
            this.body.set_size(Math.ceil(w - F * 2 + 2), Math.ceil(h));
            a.set_position(0, edge === 'top' ? 0 : Math.round(h - F));
            b.set_position(Math.round(w - F), edge === 'top' ? 0 : Math.round(h - F));
            this.bleed.set_position(0, edge === 'top' ? -O : Math.round(h));
            this.bleed.set_size(Math.ceil(w), O);
        } else if (this.full) {
            this.body.set_position(F - 1, 0);
            this.body.set_size(Math.ceil(w - F + 1), Math.ceil(h));
            a.set_position(0, 0);
            b.set_position(0, Math.round(h - F));
            this.bleed.set_position(Math.round(w), 0);
            this.bleed.set_size(O, Math.ceil(h));
        } else {
            this.body.set_position(0, F - 1);
            this.body.set_size(Math.ceil(w), Math.ceil(h - F * 2 + 2));
            const fx = edge === 'right' ? Math.round(w - F) : 0;
            a.set_position(fx, 0);
            b.set_position(fx, Math.round(h - F));
            this.bleed.set_position(edge === 'right' ? Math.round(w) : -O, 0);
            this.bleed.set_size(O, Math.ceil(h));
        }
        const horizontal = edge === 'right' || edge === 'left';
        const cx = edge === 'left' ? 0 : F;
        const cy = horizontal && !this.full ? F : 0;
        this.content.set_position(cx, cy);
        this._w = w;
        this._h = h;
    }

    _hiddenAt() {
        return {top: [0, -this._h], bottom: [0, this._h], right: [this._w, 0], left: [-this._w, 0]}[this.edge];
    }

    _applyReveal(p) {
        const [hx, hy] = this._hiddenAt();
        // Past 1 is the bounce. With no room reserved for it, stop at the rest position instead.
        const q = this._over ? p : Math.min(p, 1);
        this.slider.set_translation((1 - q) * hx, (1 - q) * hy, 0);
    }

    _applyMorph(t) {
        const {from, to} = this._morph;
        if (to.anchor !== undefined) this.anchorY = from.anchor + (to.anchor - from.anchor) * t;
        this._applyGeometry(from.w + (to.w - from.w) * t, from.h + (to.h - from.h) * t, to);
        this._applyReveal(this.reveal.value);
    }

    /** First-frame work (layout, text shaping) lands here, before anything moves. */
    _prepareOpen() {
        if (this._flareRadius !== ROUNDING) this._makeFlares();
        const t = this._measure();
        this.size.stop();
        this._applyGeometry(t.w, t.h, t);
        this._target = t;
    }

    /**
     * Summoned by resting on a screen edge, so it goes away when the pointer does. Opened by a key
     * or click, it stays until dismissed.
     */
    _watchPointer(e) {
        if (!this._transient || !this.isOpen) return;
        const [x, y] = e.get_coords();
        // Still dragging something, such as a slider that has run past the panel's edge.
        const dragging = e.get_state() & Clutter.ModifierType.BUTTON1_MASK;
        if (dragging || this._near(x, y)) {
            this._cancelLeave();
            return;
        }
        if (this._leaveTimer) return;
        this._leaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_DELAY, () => {
            this._leaveTimer = 0;
            if (this._transient) this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The panel with some slack, reaching to the screen edge so the hot zone that opened it counts. */
    _near(x, y) {
        const [sx, sy] = this.slider.get_transformed_position();
        const x1 = this.edge === 'left' ? 0 : sx - NEAR;
        const x2 = this.edge === 'right' ? global.stage.width : sx + this._w + NEAR;
        const y1 = this.edge === 'top' ? 0 : sy - NEAR;
        const y2 = this.edge === 'bottom' ? global.stage.height : sy + this._h + NEAR;
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    }

    _cancelLeave() {
        if (this._leaveTimer) GLib.source_remove(this._leaveTimer);
        this._leaveTimer = 0;
    }

    open({quiet = false, transient = false} = {}) {
        if (this.isOpen) {
            if (!transient) this._transient = false;
            return;
        }
        this._transient = transient;
        if (!quiet) this.shell.closeDrawers(this);
        this.isOpen = true;
        const wasHidden = !this.root.visible;
        this.onOpen?.();
        this.root.show();
        // Before measuring: widgets only pick up CSS spacing once on stage, and measuring first
        // came out too narrow, leaving the content hanging over the panel's edge.
        this.backdrop?.show();
        this._prepareOpen();
        if (this.modal) {
            this.backdrop.reactive = true;
            this._grab = Main.pushModal(this.backdrop);
            this.backdrop.grab_key_focus();
            this.onFocus?.();
        }
        if (wasHidden) {
            this.reveal.set(0);
            this._stagger();
        }
        this.content.remove_transition('opacity');
        this.content.opacity = 255;
        this.reveal.to(1, overshoots() && this._over ? {} : {damping: 1});
    }

    /** Sections arrive one after another, so a big panel unfolds instead of landing as a block. */
    _stagger() {
        const parts = this.staggerParts?.() ?? [];
        const dy = this.edge === 'bottom' ? 14 : this.edge === 'top' ? -14 : 0;
        const dx = this.edge === 'right' ? 18 : this.edge === 'left' ? -18 : 0;
        parts.forEach((a, i) => enter(a, {delay: 40 + i * 26, duration: 420, dx, dy}));
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this._cancelLeave();
        this.shell.lastClose = GLib.get_monotonic_time();
        this._releaseModal();
        this.onClose?.();
        if (!reduced())
            this.content.ease({opacity: 110, duration: ms(160), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.reveal.to(0, {
            damping: 1, response: closeResponse(),
            onDone: () => {
                if (this.isOpen) return;
                this.root.hide();
                this.backdrop?.hide();
                this.content.opacity = 255;
            },
        });
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    /** For left-edge popouts: the screen height to centre on. Takes effect at the next relayout or open. */
    setFixedWidth(w) { this._fixedWidth = w; }

    setAnchor(y) {
        this._anchorTo = y;
        if (!this.isOpen) this.anchorY = y;
    }

    /** Glide to the content's new size (tab switch, new notification, search results). */
    relayout({animate = true} = {}) {
        // While opening, _prepareOpen does the measuring; nothing is on screen to glide yet.
        if (!this.isOpen || !this.root.visible) return;
        if (this._flareRadius !== ROUNDING) this._makeFlares();
        const to = this._measure();
        to.anchor = this._anchorTo;
        const from = {w: this._w ?? to.w, h: this._h ?? to.h, anchor: this.anchorY ?? this._anchorTo};
        if (!animate || reduced() || (from.w === to.w && from.h === to.h && from.anchor === to.anchor)) {
            this.size.stop();
            this.anchorY = this._anchorTo;
            this._applyGeometry(to.w, to.h, to);
            this._applyReveal(this.reveal.value);
            return;
        }
        this._morph = {from, to};
        // A morph may be mid-flight: restart from where it visibly is, at the same speed.
        const carried = this.size.moving ? this.size.velocity : 0;
        this.size.set(0);
        this.size.velocity = carried;
        this.size.to(1);
    }

    _releaseModal() {
        if (!this.modal || !this._grab) return;
        Main.popModal(this._grab);
        this._grab = null;
        // Stays visible until the slide-out ends, because the panel is its child.
        this.backdrop.reactive = false;
    }

    destroy() {
        this._cancelLeave();
        this.reveal.destroy();
        this.size.destroy();
        this._releaseModal();
        (this.backdrop ?? this.root).destroy();
    }
}
