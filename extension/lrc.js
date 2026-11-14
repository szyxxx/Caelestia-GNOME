// Lyric parsing and search matching. No imports, so tests can run it outside the shell.

export function parseLrc(text) {
    const lines = [];
    for (const raw of (text ?? '').split('\n')) {
        const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        const words = raw.replace(/\[[^\]]*\]/g, '').trim();
        for (const m of stamps)
            lines.push({t: Number(m[1]) * 60 + Number(m[2]), text: words});
    }
    return lines.sort((a, b) => a.t - b.t);
}

const NOISE = /\s*[\(\[][^\)\]]*\b(official|lyrics?|lyric video|audio|video|visuali[sz]er|mv|m\/v|hd|4k|remaster(ed)?|explicit|prod\.?)\b[^\)\]]*[\)\]]/gi;

/** Video sites give "Artist - Song (Official Video)" by "ArtistVEVO"; lyric search needs the real names. */
export function lyricQueries(artist, title) {
    const cleanTitle = title.replace(NOISE, '').replace(/\s*\|.*$/, '').replace(/\s+/g, ' ').trim();
    const cleanArtist = artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*official$/i, '').trim();
    const out = [];
    const dash = cleanTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) out.push({artist: dash[1].trim(), title: dash[2].trim()});
    if (cleanArtist) out.push({artist: cleanArtist, title: cleanTitle});
    return out;
}

/** Search results are matched on length too, so a talk or clip never gets a stranger's lyrics. */
export function pickLyrics(list, length) {
    const fits = x => !length || !x.duration || Math.abs(x.duration - length) <= 6;
    return list.find(x => x.syncedLyrics && fits(x)) ?? list.find(x => x.plainLyrics && fits(x)) ?? null;
}

const clean = s => s.toLowerCase().replace(/[\(\[（].*?[\)\]）]/g, '').replace(/\s+/g, ' ').trim();

/**
 * NetEase search results worth asking lyrics for, best first. Exact names outrank ones with a
 * "(Remastered)" style suffix, and the artist and length must agree, so a cover or a remix with
 * the same title is never picked.
 */
export function pickNetease(songs, title, artist, length) {
    const want = clean(title), who = artist.toLowerCase();
    const fits = s => (!length || !s.duration || Math.abs(s.duration / 1000 - length) <= 6) &&
        (s.artists ?? []).some(a => {
            const n = (a.name ?? '').toLowerCase();
            return n && (who.includes(n) || n.includes(who));
        });
    const exact = songs.filter(s => (s.name ?? '').toLowerCase() === title.toLowerCase() && fits(s));
    const close = songs.filter(s => clean(s.name ?? '') === want && fits(s) && !exact.includes(s));
    return [...exact, ...close].slice(0, 4);
}

/** Drops the credits NetEase timestamps as if they were lyrics ("作词 : Someone") from the start. */
export function stripCredits(lrc) {
    const lines = (lrc ?? '').split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
        const words = lines[i].replace(/\[[^\]]*\]/g, '').trim();
        if (words && !/^[^:：]{1,14}\s*[:：]\s*\S/.test(words)) break;
    }
    return lines.slice(i).join('\n');
}

/**
 * Settles on the first source with synced lyrics, so a slow one cannot hold up a fast one. If none
 * has them, the best plain lyrics once all have answered. Rejects only when every source failed.
 * `partial` says some source failed, so a miss should be asked again sooner.
 */
export function firstSynced(promises) {
    return new Promise((resolve, reject) => {
        let left = promises.length, failed = 0, plain = '', last = null;
        const done = () => {
            if (--left) return;
            if (failed === promises.length) reject(last ?? new Error('no lyric sources'));
            else resolve({synced: '', plain, partial: failed > 0});
        };
        if (!left) resolve({synced: '', plain: '', partial: false});
        for (const p of promises) {
            p.then(r => {
                if (r?.synced) {
                    resolve({synced: r.synced, plain: r.plain ?? '', partial: false});
                    return;
                }
                plain ||= r?.plain ?? '';
                done();
            }, e => {
                failed++;
                last = e;
                done();
            });
        }
    });
}

