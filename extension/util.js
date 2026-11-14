import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const DATA = GLib.build_filenamev([GLib.get_user_data_dir(), 'caelestia-gnome']);
export const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'caelestia-gnome']);
const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'caelestia-gnome', 'config.json']);

const DEFAULTS = {
    // Weather location; edit ~/.config/caelestia-gnome/config.json to change it.
    latitude: -6.9175, longitude: 107.6191, place: 'Bandung',
    // Sends the title and artist of what is playing to lrclib.net, once per track.
    lyrics: true,
    // Also asks NetEase (music.163.com), which is faster here and has more Asian music.
    lyricsFallback: true,
    lyricPill: false,
    // true: the desktop lyric line stays visible over maximized windows instead of stepping aside.
    lyricPillPinned: false,
    // Phone Link: raise the laptop's own hotspot when there is no Wi-Fi, so the phone can still connect.
    phoneLinkAuto: false,
    debugMotion: false,
};

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch { return null; }
}

function writeText(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
}

export function loadConfig() {
    let user = {};
    try { user = JSON.parse(readText(CONFIG) ?? '{}'); } catch {}
    return {...DEFAULTS, ...user};
}

export function saveConfig(values) {
    let user = {};
    try { user = JSON.parse(readText(CONFIG) ?? '{}'); } catch {}
    writeText(CONFIG, JSON.stringify({...user, ...values}, null, 1));
}

export class Store {
    constructor() {
        this.path = GLib.build_filenamev([DATA, 'state.json']);
        this.state = {tasks: [], focus: null};
        try { Object.assign(this.state, JSON.parse(readText(this.path) ?? '{}')); } catch {}
    }

    save() {
        writeText(this.path, JSON.stringify(this.state));
    }
}

export const hash = s => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, s, -1);

let session = null;
export function httpSession() {
    session ??= new Soup.Session({timeout: 30, user_agent: 'caelestia-gnome/1 (GNOME Shell extension)'});
    return session;
}
export function dropSession() {
    session?.abort();
    session = null;
}

export function fetchBytes(url) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) { reject(new Error(`bad url ${url}`)); return; }
        httpSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200) reject(new Error(`http ${msg.get_status()}`));
                else resolve(bytes);
            } catch (e) { reject(e); }
        });
    });
}

export async function fetchJson(url) {
    const bytes = await fetchBytes(url);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

export async function cacheFile(url) {
    const path = GLib.build_filenamev([CACHE, 'art', hash(url)]);
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
    const bytes = await fetchBytes(url);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, bytes.get_data());
    return path;
}

export function cacheGet(name) {
    try { return JSON.parse(readText(GLib.build_filenamev([CACHE, name])) ?? 'null'); } catch { return null; }
}
export function cacheSet(name, value) {
    writeText(GLib.build_filenamev([CACHE, name]), JSON.stringify(value));
}

export const asset = (dir, name) => Gio.File.new_for_path(GLib.build_filenamev([dir, 'assets', name]));
export const fileIcon = (dir, name) => new Gio.FileIcon({file: asset(dir, name)});

export function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
