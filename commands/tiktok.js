// TikTok downloader (no watermark) using the free TikWM API.
// Needs Node 18+ (built-in fetch). No API key required.

const TIKWM = 'https://www.tikwm.com';

function fullUrl(u) {
    if (!u) return null;
    return u.startsWith('http') ? u : `${TIKWM}${u}`;
}

async function tiktokCommand(sock, chatId, message) {
    const rawText =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        '';
    const link = rawText.trim().split(/\s+/)[1];

    if (!link || !/tiktok\.com/i.test(link)) {
        await sock.sendMessage(chatId, {
            text: '❌ *Usage:* .tiktok <TikTok link>'
        }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

        const res = await fetch(`${TIKWM}/api/?url=${encodeURIComponent(link)}&hd=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const json = await res.json();

        if (json.code !== 0 || !json.data) {
            throw new Error(json.msg || 'Could not fetch this video');
        }

        const d = json.data;
        const caption =
            `🎵 *TikTok Downloader*\n\n` +
            `👤 ${d.author?.nickname || d.author?.unique_id || 'Unknown'}\n` +
            `📝 ${(d.title || '').slice(0, 200)}\n` +
            `❤️ ${d.digg_count ?? '-'}   👁️ ${d.play_count ?? '-'}`;

        if (Array.isArray(d.images) && d.images.length) {
            // Slideshow post: send up to 5 images
            for (const img of d.images.slice(0, 5)) {
                await sock.sendMessage(chatId, { image: { url: img } }, { quoted: message });
            }
            await sock.sendMessage(chatId, { text: caption }, { quoted: message });
        } else {
            const videoUrl = fullUrl(d.hdplay || d.play);
            if (!videoUrl) throw new Error('No video link returned');

            await sock.sendMessage(chatId, {
                video: { url: videoUrl },
                caption
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    } catch (error) {
        console.error('[TIKTOK] failed:', error?.stack || error);
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        await sock.sendMessage(chatId, {
            text: `❌ Download failed: ${error.message || 'Try again later.'}`
        }, { quoted: message });
    }
}

module.exports = tiktokCommand;
