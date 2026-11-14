/**
 * A small QR code encoder: byte mode, error correction M, versions 1-10 (up to 213 bytes).
 * Enough for a Wi-Fi join code. Follows Nayuki's reference implementation of ISO/IEC 18004.
 * qr(text) -> {size, dark(x, y)}
 */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0; // ECC level M's format bits

function rawModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const n = Math.floor(ver / 7) + 2;
        r -= (25 * n - 10) * n - 55;
        if (ver >= 7) r -= 36;
    }
    return r;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < r.length; j++) {
            r[j] = gfMul(r[j], root);
            if (j + 1 < r.length) r[j] ^= r[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return r;
}

function rsRemainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) {
        const f = b ^ r.shift();
        r.push(0);
        div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
    }
    return r;
}

function alignPositions(ver, size) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const r = [6];
    for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
    return r;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

export function qr(text, {mask = -1} = {}) {
    const bytes = [...new TextEncoder().encode(text)];
    let ver = 1;
    // 4 bits mode + count bits + data
    while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 10) throw new Error('QR text too long');
    const size = ver * 4 + 17;

    // ---- data bits ----
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(b => put(b, 8));
    const cap = dataCodewords(ver) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // ---- blocks + error correction, interleaved ----
    const nb = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
        const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, div);
        if (i < nShort) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const words = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) words.push(b[i]); });
    }

    // ---- function patterns ----
    const m = Array.from({length: size}, () => new Array(size).fill(false));
    const fn = Array.from({length: size}, () => new Array(size).fill(false));
    const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
            if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
        }
    }
    const al = alignPositions(ver, size);
    al.forEach((ax, i) => al.forEach((ay, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const bit = (v, i) => ((v >>> i) & 1) !== 0;
    const drawFormat = mk => {
        const d = (FORMAT_M << 3) | mk;
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const b = ((d << 10) | rem) ^ 0x5412;
        for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
        set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
        set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const b = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const a = size - 11 + i % 3, c = Math.floor(i / 3);
            set(a, c, bit(b, i)); set(c, a, bit(b, i));
        }
    }

    // ---- codewords in the zigzag ----
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
            const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
            if (!fn[y][x] && i < words.length * 8) { m[y][x] = bit(words[i >>> 3], 7 - (i & 7)); i++; }
        }
    }

    const applyMask = mk => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mk](x, y)) m[y][x] = !m[y][x];
    };
    // Penalty: runs, 2x2 blocks, finder-like patterns, dark balance (the standard four rules).
    const penalty = () => {
        let p = 0;
        const line = get => {
            let run = 0, prev = null;
            const hist = [];
            for (let k = 0; k < size; k++) {
                const c = get(k);
                if (c === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { run = 1; prev = c; }
                hist.push(c ? 1 : 0);
            }
            const s = hist.join('');
            for (const pat of ['10111010000', '00001011101']) for (let k = s.indexOf(pat); k >= 0; k = s.indexOf(pat, k + 1)) p += 40;
        };
        for (let y = 0; y < size; y++) line(x => m[y][x]);
        for (let x = 0; x < size; x++) line(y => m[y][x]);
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
            const c = m[y][x];
            if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
        }
        const dark = m.flat().filter(Boolean).length, total = size * size;
        p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return p;
    };
    if (mask < 0) {
        let best = 0, bestP = Infinity;
        for (let mk = 0; mk < 8; mk++) {
            applyMask(mk); drawFormat(mk);
            const p = penalty();
            if (p < bestP) { bestP = p; best = mk; }
            applyMask(mk);
        }
        mask = best;
    }
    applyMask(mask);
    drawFormat(mask);
    return {size, version: ver, mask, dark: (x, y) => m[y][x]};
}

/** The text Android's camera and Wi-Fi settings read as "join this network". */
export function wifiQrText(ssid, psk) {
    const esc = s => s.replace(/([\\;,:"])/g, '\\$1');
    return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(psk)};;`;
}
