import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {springStep} from './spring.js';

/**
 * response: seconds for one natural swing, the "weight" of the motion.
 * damping: 1 lands with no overshoot, below 1 bounces.
 * scale: multiplier for simple fades, so every preset keeps one tempo.
 */
export const PRESETS = {
    fluid: {response: .46, damping: 1, closeResponse: .34, scale: 1},
    expressive: {response: .54, damping: .74, closeResponse: .34, scale: 1},
    calm: {response: .72, damping: 1, closeResponse: .5, scale: 1.5},
    snappy: {response: .24, damping: 1, closeResponse: .2, scale: .6},
    off: null,
};

let current = PRESETS.fluid;
export function setMotion(name) { current = PRESETS[name] === undefined ? PRESETS.fluid : PRESETS[name]; }
export const reduced = () => !current || !St.Settings.get().enable_animations;
export const overshoots = () => !!current && current.damping < 1;
export const ms = d => reduced() ? 0 : Math.round(d * current.scale);
export const closeResponse = () => current?.closeResponse ?? .34;

/** Everything below the frame rate this long is recorded when config.debugMotion is set. */
export const frameLog = {enabled: false, samples: []};

const MAX_DT = 1 / 30;
const EPS_X = .0005, EPS_V = .02;

/**
 * A value that moves on the compositor's frame clock. Calling to() mid-flight keeps the current
 * velocity, so interrupting a motion curves into the new one instead of stopping dead.
 */
export class Spring {
    /**
     * @param actor the frame clock follows this actor's monitor
     * @param apply called with the value every frame
     * @param opts.value start value; opts.response, opts.damping override the active preset
     * @param opts.span size of the motion, so a 2 px move and a 900 px move settle alike
     */
    constructor(actor, apply, {value = 0, response, damping, span = 1} = {}) {
        Object.assign(this, {actor, apply, value, velocity: 0, target: value, _response: response, _damping: damping, _span: span});
    }

    get moving() { return !!this._timeline; }

    /** Jump with no motion. */
    set(v) {
        this.stop();
        this.value = this.target = v;
        this.velocity = 0;
        this.apply(v);
    }

    to(target, {onDone, response, damping} = {}) {
        this._onDone = onDone;
        this.target = target;
        this._frameResponse = response ?? this._response ?? current?.response;
        this._frameDamping = damping ?? this._damping ?? current?.damping;
        if (reduced() || !this.actor.mapped) {
            this.set(target);
            this._finish();
            return;
        }
        if (this._timeline) return;
        this._timeline = Clutter.Timeline.new_for_actor(this.actor, 1000);
        this._timeline.repeat_count = -1;
        this._last = null;
        this._timeline.connect('new-frame', () => this._frame());
        this._timeline.start();
    }

    _frame() {
        // The timeline only reports whole milliseconds, which is 15% noise per frame at 165 Hz.
        const now = GLib.get_monotonic_time();
        const raw = this._last === null ? 1 / 165 : (now - this._last) / 1e6;
        this._last = now;
        if (raw <= 0) return;
        if (frameLog.enabled && frameLog.samples.length < 20000) frameLog.samples.push(Math.round(raw * 10000) / 10);
        // A long frame continues from where the eye last saw it rather than leaping ahead.
        [this.value, this.velocity] = springStep(this.value, this.velocity, this.target,
            Math.min(raw, MAX_DT), this._frameResponse, this._frameDamping);
        const eps = EPS_X * this._span;
        if (Math.abs(this.value - this.target) < eps && Math.abs(this.velocity) < EPS_V * this._span) {
            this.value = this.target;
            this.velocity = 0;
            this.apply(this.value);
            this.stop();
            this._finish();
            return;
        }
        this.apply(this.value);
    }

    _finish() {
        const fn = this._onDone;
        this._onDone = null;
        fn?.();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    destroy() {
        this.stop();
        this._onDone = null;
    }
}

/** Fade with a small drift, for anything entering. */
export function enter(actor, {delay = 0, duration = 340, dx = 0, dy = 0} = {}) {
    actor.remove_transition('opacity');
    const d = ms(duration);
    if (!d) { actor.set({opacity: 255, translation_x: 0, translation_y: 0}); return; }
    actor.set({opacity: 0, translation_x: dx, translation_y: dy});
    actor.ease({opacity: 255, translation_x: 0, translation_y: 0, delay, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUINT});
}

/** Fade something out, swap its content at the invisible point, fade back in. */
export function swap(actor, change, {out = 90, back = 240} = {}) {
    if (reduced() || !actor.mapped) { change(); actor.opacity = 255; return; }
    actor.remove_transition('opacity');
    actor.ease({
        opacity: 0, duration: ms(out), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: finished => {
            if (!finished) return;
            change();
            actor.ease({opacity: 255, duration: ms(back), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        },
    });
}
