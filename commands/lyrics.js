// commands/lyrics.js
const fs = require('fs');
const path = require('path');
const fetchFn = global.fetch || require('node-fetch');

const API = 'https://lrclib.net/api/search';
const HEADERS = { 'User-Agent': 'Andy-xmd v2 (https://github.com/andytech580/ANDY-XMD)' };
const MAX_CHARS = 3500;
const BANNER = path.join(__dirname, '../assets/banner.jpg'); // change to your banner path

// ".lyrics the weeknd - blinding lights" -> { artist, track }
function parseInput(input) {
    const parts = input.split(/\s+-\s+/);
    return parts.length > 1
        ? { artist: parts[0].trim(), track: parts.slice(1).join(' - ').trim() }
        : { artist: null, track: input.trim() };
}

function pickBest(results, { artist, track }) {
    const t = track.toLowerCase();
    const a = artist?.toLowerCase();
    const score = (r) =>
        (r.trackName?.toLowerCase() === t ? 4 : 0) +
        (a && r.artistName?.toLowerCase().includes(a) ? 4 : 0) +
        (r.syncedLyrics ? 1 : 0);
    return [...results].sort((x, y) => score(y) - score(x))[0];
}

function splitText(text, max = MAX_CHARS) {
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if ((cur + line).length > max) {
            chunks.push(cur.trim());
            cur = '';
        }
        cur += line + '\n';
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Album art from the iTunes Search API (free, no key). Returns a URL or null.
async function getCover(artist, track) {
    try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${track}`)}&entity=song&limit=1`;
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
        const res = await Promise.race([fetchFn(url), timeout]);
        if (!res || !res.ok) return null;
        const json = await res.json();
        const art = json?.results?.[0]?.artworkUrl100;
        return art ? art.replace('100x100bb', '600x600bb') : null;
    }
    catch {
        return null;
    }
}

async function lyricsCommand(sock, chatId, songTitle, message) {
    if (!songTitle || !songTitle.trim()) {
        await sock.sendMessage(chatId, {
            text: '*Please enter the song name to get the lyrics!*\nUsage: `.lyrics <song name>`\nMore accurate: `.lyrics <artist> - <song>`',
            quoted: message
        });
        return;
    }

    songTitle = songTitle.trim();

    try {
        const query = parseInput(songTitle);
        const params = query.artist
            ? new URLSearchParams({ artist_name: query.artist, track_name: query.track })
            : new URLSearchParams({ q: query.track });

        const res = await fetchFn(`${API}?${params}`, { headers: HEADERS });
        if (!res.ok)
            throw new Error(`API request failed with status ${res.status}`);

        const data = await res.json();
        const results = Array.isArray(data)
            ? data.filter((r) => r.plainLyrics && !r.instrumental)
            : [];

        if (!results.length) {
            await sock.sendMessage(chatId, {
                text: `❌ Sorry, I couldn't find any lyrics for "${songTitle}".`,
                quoted: message
            });
            return;
        }

        const hit = pickBest(results, query);
        const header =
            `🎵 *${hit.trackName}*\n` +
            `👤 *Artist:* ${hit.artistName}\n` +
            (hit.albumName ? `💿 *Album:* ${hit.albumName}\n` : '') +
            (hit.duration ? `⏱️ *Duration:* ${mmss(hit.duration)}\n` : '') +
            '\n📝 *Lyrics:*';

        const chunks = splitText(hit.plainLyrics);

        // Banner candidates: album cover first, then your own banner
        const candidates = [];
        const cover = await getCover(hit.artistName, hit.trackName);
        if (cover) candidates.push({ url: cover });
        if (fs.existsSync(BANNER)) candidates.push(fs.readFileSync(BANNER));

        let imageSent = false;
        for (const image of candidates) {
            try {
                await sock.sendMessage(chatId, {
                    image,
                    caption: header,
                    quoted: message
                });
                imageSent = true;
                break;
            }
            catch (imgError) {
                console.error('Lyrics banner send failed:', imgError.message);
            }
        }

        if (imageSent) {
            for (const chunk of chunks) {
                await sock.sendMessage(chatId, {
                    text: chunk,
                    quoted: message
                });
            }
        }
        else {
            await sock.sendMessage(chatId, {
                text: `${header}\n${chunks[0]}`,
                quoted: message
            });
            for (const chunk of chunks.slice(1)) {
                await sock.sendMessage(chatId, {
                    text: chunk,
                    quoted: message
                });
            }
        }
    }
    catch (error) {
        console.error('Lyrics Command Error:', error);
        try {
            await sock.sendMessage(chatId, {
                text: `❌ An error occurred while fetching the lyrics for "${songTitle}".`,
                quoted: message
            });
        }
        catch (sendError) {
            console.error('Lyrics error reply failed:', sendError);
        }
    }
}

module.exports = lyricsCommand;