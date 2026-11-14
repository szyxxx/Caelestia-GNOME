import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Spring, closeResponse} from './motion.js';

/**
 * Spring motion for normal windows (open, close, minimize, restore) and the workspace slide.
 *
 * GNOME binds its window handlers once at startup, so they cannot be swapped. Instead, when GNOME
 * decides to animate a normal window, the one ease() call it is about to make on that actor is
 * taken over by a spring, and GNOME's own onStopped runs at the end. Its bookkeeping (dialog
 * dimming, kill-window-effects, waiting for the overview) therefore stays exactly as it was.
 * Dialogs and every other window type keep GNOME's animation.
 */

const OPS = ['_mapWindow', '_destroyWindow', '_minimizeWindow', '_unminimizeWindow'];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));

/** Which WindowManager method is asking, read from the call stack. */
function caller() {
    for (const line of (new Error().stack ?? '').split('\n')) {
        const name = line.split('@')[0];
        if (OPS.includes(name)) return name;
    }
    return null;
}

/** Does this ease() look like the one the given operation makes? Anything else passes through. */
function matches(op, p) {
    switch (op) {
    case '_mapWindow': return p.opacity === 255;
    case '_destroyWindow': return p.opacity === 0;
    case '_minimizeWindow': return p.opacity === 0;
    case '_unminimizeWindow': return p.opacity === 255 || p.scale_x === 1;
    }
    return false;
}

export class WindowMotion {
    constructor() {
        this._springs = new Map();   // actor -> Spring
        const wm = Main.wm;

        this._origShould = wm._shouldAnimateActor;
        wm._shouldAnimateActor = (actor, types) => {
            const ok = this._origShould.call(wm, actor, types);
            if (ok) {
                const op = caller();
                if (op && wm._getAnimationWindowType(actor) === Meta.WindowType.NORMAL) this._claim(actor, op);
            }
            return ok;
        };

        // GNOME resets the actor on kill-window-effects; stop the spring so it cannot write over that.
        global.window_manager.connectObject('kill-window-effects', (_wm, actor) => this._stop(actor), this);

        const ws = wm._workspaceAnimation;
        this._ws = ws;
        this._origPrepare = ws._prepareWorkspaceSwitch;
        ws._prepareWorkspaceSwitch = (...args) => {
            this._origPrepare.apply(ws, args);
            for (const group of ws._switchData?.monitors ?? []) this._springGroup(group);
        };
    }

    /** Take over the next matching ease() on this actor. */
    _claim(actor, op) {
        const own = Object.prototype.hasOwnProperty.call(actor, 'ease');
        if (own) delete actor.ease;
        actor.ease = params => {
            delete actor.ease;
            if (!matches(op, params)) return actor.ease(params);
            this._run(actor, op, params);
            return undefined;
        };
    }

    _run(actor, op, params) {
        this._stop(actor);
        const done = () => {
            this._springs.delete(actor);
            actor.disconnectObject(this);
            actor.translation_y = 0;
            params.onStopped?.(true);
            params.onComplete?.();
        };
        const win = actor.meta_window;
        const mon = Main.layoutManager.monitors[win?.get_monitor() ?? -1];
        // Minimize falls toward the bottom of the screen, where the launcher lives.
        const drop = mon ? Math.max(0, Math.min(mon.y + mon.height - (actor.y + actor.height), mon.height * .25)) + actor.height * .2 : 120;

        let apply, from, to, response;
        switch (op) {
        case '_mapWindow':
            actor.set_pivot_point(.5, .5);
            apply = t => {
                actor.opacity = Math.round(255 * clamp01(t * 1.8));
                actor.set_scale(lerp(.9, 1, t), lerp(.9, 1, t));
                actor.translation_y = lerp(14, 0, t);
            };
            [from, to, response] = [0, 1, .38];
            break;
        case '_destroyWindow':
            actor.set_pivot_point(.5, .5);
            apply = t => {
                actor.opacity = Math.round(255 * clamp01(t * 1.4 - .4) ** .8);
                actor.set_scale(lerp(.9, 1, t), lerp(.9, 1, t));
                actor.translation_y = lerp(10, 0, t);
            };
            [from, to, response] = [1, 0, closeResponse()];
            break;
        case '_minimizeWindow':
            actor.set_scale(1, 1);
            actor.set_pivot_point(.5, 1);
            apply = t => {
                actor.opacity = Math.round(255 * clamp01(t * 1.5 - .3));
                actor.set_scale(lerp(.18, 1, t), lerp(.18, 1, t));
                actor.translation_y = lerp(drop, 0, t);
            };
            [from, to, response] = [1, 0, .42];
            break;
        case '_unminimizeWindow':
            // GNOME parked the actor at its icon or the screen corner; put it back where it belongs.
            if (params.x !== undefined) actor.set_position(params.x, params.y);
            actor.set_pivot_point(.5, 1);
            apply = t => {
                actor.opacity = Math.round(255 * clamp01(t * 1.6));
                actor.set_scale(lerp(.18, 1, t), lerp(.18, 1, t));
                actor.translation_y = lerp(drop, 0, t);
            };
            [from, to, response] = [0, 1, .42];
            break;
        }
        // A window that is not on screen yet has no frame clock; Spring then lands at once.
        const s = new Spring(actor, apply, {value: from, damping: 1, response});
        this._springs.set(actor, s);
        apply(from);
        actor.connectObject('destroy', () => this._stop(actor), this);
        s.to(to, {onDone: done});
    }

    _stop(actor) {
        const s = this._springs.get(actor);
        if (!s) return;
        this._springs.delete(actor);
        s.destroy();
        actor.translation_y = 0;
        actor.disconnectObject?.(this);
    }

    /** The workspace slide eases each monitor group's progress; spring it instead. */
    _springGroup(group) {
        if (group._caeSpring) return;
        const orig = group.ease_property;
        group.ease_property = (prop, value, params = {}) => {
            if (prop !== 'progress') return orig.call(group, prop, value, params);
            let s = group._caeSpring;
            if (!s) {
                s = group._caeSpring = new Spring(group, v => { group.progress = v; }, {value: group.progress, damping: 1, response: .34});
                group.connect('destroy', () => s.destroy());
            } else {
                // GNOME snaps progress back before re-aiming; resume from where it really is.
                group.progress = s.value;
            }
            s.to(value, {onDone: () => { params.onStopped?.(true); params.onComplete?.(); }});
            return undefined;
        };
    }

    destroy() {
        for (const a of [...this._springs.keys()]) this._stop(a);
        global.window_manager.disconnectObject(this);
        // The originals live on the prototypes; dropping the overrides brings them back.
        delete Main.wm._shouldAnimateActor;
        delete this._ws._prepareWorkspaceSwitch;
        // A switch still in flight finishes with GNOME's own animation.
        for (const g of this._ws._switchData?.monitors ?? []) {
            g._caeSpring?.destroy();
            delete g.ease_property;
            g._caeSpring = null;
        }
    }
}
