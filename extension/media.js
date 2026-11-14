import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {firstSynced, lyricQueries, parseLrc, pickLyrics, pickNetease, stripCredits} from './lrc.js';
import {CACHE, cacheFile, cacheGet, cacheSet, fetchJson, hash} from './util.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJ = '/org/mpris/MediaPlayer2';
const IFACE = 'org.mpris.MediaPlayer2.Player';

const NEGATIVE_DAYS = 7;
const RETRY_PARTIAL_SECONDS = 3600;
// Past this it is a talk, stream or mix: no lyrics to find, and its title is nobody else's business.
const MAX_SONG_SECONDS = 15 * 60;
const SEARCH_TIMEOUT = 12;

function withTimeout(promise, seconds) {
    return new Promise((resolve, reject) => {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            reject(new Error('timed out'));
            return GLib.SOURCE_REMOVE;
        });
        promise.then(v => { GLib.source_remove(id); resolve(v); }, e => { GLib.source_remove(id); reject(e); });
    });
}

export class Media extends Signals.EventEmitter {
    constructor(config) {
        super();
        this._config = config;
        this._players = new Map();
        this.track = null;       // {title, artist, album, length, art, blur, accent}
        this.lyrics = [];
        this.plainLyrics = null;
        this.lyricsState = 'idle';   // idle | searching | ready | none | offline | off
        this.playing = false;
        this._watching = false;  // someone is showing the position; otherwise do not poll for it
        this._precise = false;   // the seek bar is on screen and wants a tight position
        this._pollId = 0;
        this._pos = 0;
        this._posAt = 0;
        this._trackKey = '';
        this._artUrl = null;
        this._dead = false;

        this._nameSub = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (c, s, o, i, sig, params) => {
                const [name, , owner] = params.deepUnpack();
                if (!name.startsWith(PREFIX)) return;
                if (owner) this._add(name);
                else this._remove(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null,
            (c, res) => {
                try {
                    for (const n of c.call_finish(res).deepUnpack()[0])
                        if (n.startsWith(PREFIX)) this._add(n);
                } catch (e) { logError(e, 'caelestia-gnome'); }
            });
    }

    get watching() { return this._watching; }
    set watching(v) { this._watching = v; this._syncPoll(); }
    get precise() { return this._precise; }
    set precise(v) { this._precise = v; this._syncPoll(); }

    /**
     * Position is extrapolated from the last reading, and Seeked re-reads it at once, so polling only
     * corrects slow drift: every 6 s while something plays and is shown, 1.5 s with the seek bar open,
     * and not at all otherwise (it used to wake every 1.5 s even with nothing playing).
     */
    _syncPoll() {
        const want = this.playing && this._watching && !this._dead ? (this._precise ? 1500 : 6000) : 0;
        if (want === this._pollMs) return;
        if (this._pollId) GLib.source_remove(this._pollId);
        this._pollId = 0;
        this._pollMs = want;
        if (want) this._pollId = GLib.timeout_add(GLib.PRIORITY_LOW, want, () => { this._syncPosition(); return GLib.SOURCE_CONTINUE; });
    }

    destroy() {
        this._dead = true;
        Gio.DBus.session.signal_unsubscribe(this._nameSub);
        if (this._pollId) GLib.source_remove(this._pollId);
        this._pollId = 0;
        if (this._retry) GLib.source_remove(this._retry);
        if (this._lyricTimer) GLib.source_remove(this._lyricTimer);
        for (const name of [...this._players.keys()]) this._remove(name);
    }

    _add(name) {
        if (this._players.has(name)) return;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            name, OBJ, IFACE, null, (o, res) => {
                if (this._dead) return;
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    const id = proxy.connect('g-properties-changed', () => this._choose());
                    const sig = proxy.connect('g-signal', (p, sender, signal) => {
                        if (signal === 'Seeked' && p === this._proxy) this._syncPosition();
                    });
                    this._players.set(name, {proxy, id, sig});
                    this._choose();
                } catch (e) { logError(e, 'caelestia-gnome'); }
            });
    }

    _remove(name) {
        const p = this._players.get(name);
        if (!p) return;
        p.proxy.disconnect(p.id);
        p.proxy.disconnect(p.sig);
        this._players.delete(name);
        if (this._pinned === p.proxy) this._pinned = null;
        this._choose();
    }

    _status(proxy) {
        return proxy.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';
    }

    /** Names of everything that could be shown, for the source switch in the player. */
    get players() {
        return [...this._players.entries()].filter(([, p]) => this._status(p.proxy) !== 'Stopped');
    }

    get playerName() {
        const name = this._proxy?.get_name();
        if (!name) return '';
        const short = name.slice(PREFIX.length).replace(/\.instance.*$/, '');
        return short.charAt(0).toUpperCase() + short.slice(1);
    }

    /** Stay on the next player from now on, instead of following whichever is playing. */
    nextPlayer() {
        const all = this.players.map(([, p]) => p.proxy);
        if (all.length < 2) return;
        this._pinned = all[(all.indexOf(this._proxy) + 1) % all.length];
        this._choose();
    }

    _choose() {
        this._chooseNow();
        this._syncPoll();
    }

    _chooseNow() {
        if (this._dead) return;
        const all = [...this._players.values()].map(p => p.proxy);
        const usable = p => p && all.includes(p) && this._status(p) !== 'Stopped';
        const chosen = (usable(this._pinned) ? this._pinned : null) ??
            all.find(p => this._status(p) === 'Playing') ??
            (all.includes(this._proxy) && this._status(this._proxy) === 'Paused' ? this._proxy : null) ??
            all.find(p => this._status(p) === 'Paused') ?? null;
        this._proxy = chosen;
        if (!chosen) {
            if (this.track) {
                this.track = null;
                this.lyrics = [];
                this.plainLyrics = null;
                this.lyricsState = 'idle';
                this.playing = false;
                this._trackKey = '';
                this._artUrl = null;
                this.emit('changed');
            }
            return;
        }
        const meta = chosen.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const was = this.playing;
        this.playing = this._status(chosen) === 'Playing';
        const title = meta['xesam:title'] ?? '';
        const artist = [meta['xesam:artist']].flat().filter(Boolean).join(', ');
        const key = `${chosen.get_name()}\u0000${artist}\u0000${title}`;
        if (!title) return;
        const length = (meta['mpris:length'] ?? 0) / 1e6;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this.track = {title, artist, album: meta['xesam:album'] ?? '', length, art: null, blur: null, accent: null};
            this.lyrics = [];
            this.plainLyrics = null;
            this._artUrl = null;
            this._pos = 0;
            this._posAt = GLib.get_monotonic_time();
            this._syncPosition();
            this._queueLyrics(key);
        } else {
            // Browsers send a track in pieces (title, then length, then art), so keep reading.
            if (length && length !== this.track.length) {
                this.track.length = length;
                this._queueLyrics(key);
            }
            this.track.album = meta['xesam:album'] ?? this.track.album;
        }
        const url = meta['mpris:artUrl'] ?? null;
        if (url && url !== this._artUrl) {
            this._artUrl = url;
            this._loadArt(url, key);
        }
        if (was !== this.playing) this._syncPosition();
        this.emit('changed');
    }

    async _loadArt(url, key) {
        try {
            const path = url.startsWith('file://')
                ? GLib.filename_from_uri(url)[0] : url.startsWith('http') ? await cacheFile(url) : null;
            if (!path || this._dead || key !== this._trackKey) return;
            const art = await this._prepareArt(path).catch(e => {
                console.debug(`caelestia-gnome art tool: ${e.message}`);
                return {cover: path, blur: null, accent: null};
            });
            if (this._dead || key !== this._trackKey || url !== this._artUrl) return;
            Object.assign(this.track, {art: art.cover, blur: art.blur, accent: art.accent});
            this.emit('changed');
        } catch (e) { console.debug(`caelestia-gnome art: ${e.message}`); }
    }

    /** Off the compositor thread, because decoding a large cover would drop frames. */
    _prepareArt(path) {
        return new Promise((resolve, reject) => {
            const tool = `${this._config.extensionPath}/tools/art.py`;
            const proc = Gio.Subprocess.new(['/usr/bin/python3', '-I', tool, path, `${CACHE}/art-v2`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    if (!p.get_successful()) throw new Error('art tool failed');
                    resolve(JSON.parse(out));
                } catch (e) { reject(e); }
            });
        });
    }

    /** Metadata arrives in pieces, so wait for it to settle rather than searching for half a track. */
    _queueLyrics(key) {
        if (this._lyricTimer) GLib.source_remove(this._lyricTimer);
        if (this._retry) GLib.source_remove(this._retry);
        this._retry = 0;
        this.lyricsState = this._config.lyrics ? 'searching' : 'off';
        this._lyricTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._lyricTimer = 0;
            this._loadLyrics(key);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** LRCLIB: exact lookup, then its search, which can hang for a minute and so gets a short leash. */
    async _fromLrclib(t, queries) {
        const q = encodeURIComponent;
        let plain = '', answered = false, last = null;
        for (const c of queries) {
            try {
                const hit = await fetchJson(`https://lrclib.net/api/get?artist_name=${q(c.artist)}&track_name=${q(c.title)}&album_name=${q(t.album)}&duration=${Math.round(t.length)}`);
                answered = true;
                if (hit?.syncedLyrics) return {synced: hit.syncedLyrics};
                plain ||= hit?.plainLyrics ?? '';
            } catch (e) {
                // A 404 is an answer: this exact track is not there.
                if (/http 404/.test(e.message)) answered = true;
                else last = e;
            }
            try {
                const list = await withTimeout(fetchJson(`https://lrclib.net/api/search?track_name=${q(c.title)}&artist_name=${q(c.artist)}`), SEARCH_TIMEOUT);
                answered = true;
                const pick = pickLyrics(list, t.length);
                if (pick?.syncedLyrics) return {synced: pick.syncedLyrics};
                plain ||= pick?.plainLyrics ?? '';
            } catch (e) { last = e; }
        }
        if (!answered && last) throw last;
        return {synced: '', plain};
    }

    /** NetEase: fast from here and strong on Asian music. An unofficial API, so it may change. */
    async _fromNetease(t, queries) {
        const q = encodeURIComponent;
        for (const c of queries) {
            const found = await fetchJson(`https://music.163.com/api/search/get?s=${q(`${c.title} ${c.artist}`)}&type=1&limit=8`);
            for (const song of pickNetease(found?.result?.songs ?? [], c.title, c.artist, t.length)) {
                const d = await fetchJson(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`);
                const lrc = stripCredits(d?.lrc?.lyric);
                if (parseLrc(lrc).length >= 3) return {synced: lrc};
            }
        }
        return null;
    }

    _fetchLyrics(t) {
        const queries = lyricQueries(t.artist, t.title);
        const sources = [this._fromLrclib(t, queries)];
        if (this._config.lyricsFallback) sources.push(this._fromNetease(t, queries));
        return firstSynced(sources);
    }

    async _loadLyrics(key, attempt = 0) {
        if (!this._config.lyrics) return;
        const t = this.track;
        if (!t || key !== this._trackKey) return;
        if (t.length > MAX_SONG_SECONDS) {
            this.lyricsState = 'long';
            this.emit('changed');
            return;
        }
        // Newline, not NUL: the checksum reads a C string and would stop at the artist.
        const name = `lyrics-v3/${hash(`${t.artist}\n${t.title}`)}.json`;
        const now = Math.floor(GLib.get_real_time() / 1e6);
        let entry = cacheGet(name);
        if (!entry || (!entry.synced && now > (entry.until ?? 0))) {
            try {
                const r = await this._fetchLyrics(t);
                entry = {synced: r.synced, plain: r.plain, at: now,
                    until: now + (r.partial ? RETRY_PARTIAL_SECONDS : NEGATIVE_DAYS * 86400)};
                cacheSet(name, entry);
            } catch (e) {
                // Every source failed. That is an outage, not an answer, so it is never cached.
                console.debug(`caelestia-gnome lyrics: ${e.message}`);
                if (this._dead || key !== this._trackKey) return;
                this.lyricsState = 'offline';
                this.emit('changed');
                if (attempt < 3) {
                    this._retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8 * (attempt + 1), () => {
                        this._retry = 0;
                        if (key === this._trackKey) this._loadLyrics(key, attempt + 1);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
        }
        if (this._dead || key !== this._trackKey) return;
        this.lyrics = parseLrc(entry.synced);
        this.plainLyrics = this.lyrics.length ? null : entry.plain || null;
        this.lyricsState = this.lyrics.length || this.plainLyrics ? 'ready' : 'none';
        this.emit('changed');
    }

    _syncPosition() {
        const p = this._proxy;
        if (!p) return;
        p.get_connection().call(p.get_name(), OBJ, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [IFACE, 'Position']), null, Gio.DBusCallFlags.NONE, 1000, null,
            (c, res) => {
                if (this._dead) return;
                try {
                    this._pos = c.call_finish(res).deepUnpack()[0].unpack() / 1e6;
                    this._posAt = GLib.get_monotonic_time();
                    this.emit('position');
                } catch {}
            });
    }

    get position() {
        const extra = this.playing ? (GLib.get_monotonic_time() - this._posAt) / 1e6 : 0;
        return this._pos + extra;
    }

    /** Index of the line being sung, or -1. */
    get lineIndex() {
        const now = this.position + 0.15;
        let found = -1;
        for (let i = 0; i < this.lyrics.length && this.lyrics[i].t <= now; i++) found = i;
        return found;
    }

    /** The music app that opens when you press play with nothing playing (config.musicApp, set by caelestia-apps). */
    get musicApp() {
        const id = this._config.musicApp;
        return id ? Shell.AppSystem.get_default().lookup_app(id) : null;
    }

    command(method) {
        if (!this._proxy) {
            if (/Play/.test(method)) this.musicApp?.activate();
            return;
        }
        this._proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    seekTo(seconds) {
        const p = this._proxy;
        if (!p) return;
        const id = p.get_cached_property('Metadata')?.recursiveUnpack()?.['mpris:trackid'] ?? '/';
        p.call('SetPosition', new GLib.Variant('(ox)', [id, Math.round(seconds * 1e6)]),
            Gio.DBusCallFlags.NONE, -1, null, null);
        this._pos = seconds;
        this._posAt = GLib.get_monotonic_time();
    }
}
