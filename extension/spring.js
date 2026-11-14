/**
 * Closed-form damped spring. Exact for any time step, so the path is the same at 60 and 165 Hz
 * and a dropped frame cannot make it overshoot or jump. No imports, so tests can run it alone.
 * @returns [position, velocity] after dt seconds, heading for target.
 */
export function springStep(x, v, target, dt, response, damping) {
    const w = 2 * Math.PI / response;
    const d = x - target;
    if (damping >= 1) {
        const e = Math.exp(-w * dt), c = v + w * d;
        return [target + e * (d + c * dt), e * (v - w * c * dt)];
    }
    const wd = w * Math.sqrt(1 - damping * damping), zw = damping * w;
    const e = Math.exp(-zw * dt), cos = Math.cos(wd * dt), sin = Math.sin(wd * dt);
    const b = (v + zw * d) / wd;
    return [target + e * (d * cos + b * sin),
        e * ((b * wd - zw * d) * cos - (d * wd + zw * b) * sin)];
}
