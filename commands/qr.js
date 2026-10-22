const QRCode = require('qrcode');
const jsQR = require('jsqr');
const J = require('jimp');
const Jimp = J.Jimp || J; // works with jimp 0.x and 1.x
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const MAX_TEXT = 1000;

const channelInfo = {
    contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363421568891511@newsletter',
            newsletterName: 'Andy-xmd',
            serverMessageId: -1
        }
    }
};

/* ---------- helpers ---------- */

function getQuoted(message) {
    return message.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

function getQuotedText(quoted) {
    if (!quoted) return '';
    return (
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        ''
    ).trim();
}

async function downloadImage(imageMsg) {
    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function scan(bitmap) {
    return jsQR(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height, {
        inversionAttempts: 'attemptBoth',
    });
}

// Try the raw image first, then a few enhanced versions (small / low-contrast photos)
async function decodeQr(buffer) {
    const base = await Jimp.read(buffer);

    const attempts = [
        (img) => img,
        (img) => img.greyscale().contrast(0.5),
        (img) => { if (img.bitmap.width > 1000) img.resize({ w: 1000 }); return img; },
        (img) => { if (img.bitmap.width < 600) img.resize({ w: 900 }); return img.greyscale().contrast(0.6); },
    ];

    for (const step of attempts) {
        try {
            const img = base.clone();
            const out = step(img) || img;
            const code = scan(out.bitmap);
            if (code && code.data) return code.data;
        } catch (e) {
            // some jimp versions use different resize signatures; just try the next attempt
        }
    }
    return null;
}

/* ---------- .qr <text> ---------- */

async function qrCommand(sock, chatId, message, rawText) {
    try {
        let text = (rawText || '').replace(/^\.qr(code)?/i, '').trim();

        // allow replying to a text message
        if (!text) text = getQuotedText(getQuoted(message));

        if (!text) {
            await sock.sendMessage(chatId, {
                text: '*Usage:*\n.qr <text or link>\nor reply to a message with *.qr*\n\n*Example:* .qr https://example.com',
                ...channelInfo
            }, { quoted: message });
            return;
        }

        if (text.length > MAX_TEXT) {
            await sock.sendMessage(chatId, {
                text: `❌ Text is too long (${text.length}). Max is ${MAX_TEXT} characters.`,
                ...channelInfo
            }, { quoted: message });
            return;
        }

        const buffer = await QRCode.toBuffer(text, {
            type: 'png',
            width: 800,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#ffffff' },
        });

        const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
        await sock.sendMessage(chatId, {
            image: buffer,
            caption: `✅ *QR code ready*\n\n📝 ${preview}`,
            ...channelInfo
        }, { quoted: message });

    } catch (error) {
        console.error('Error in qr command:', error);
        await sock.sendMessage(chatId, { text: '❌ Failed to create the QR code. Please try again.', ...channelInfo }, { quoted: message });
    }
}

/* ---------- .readqr (reply to an image, or send an image with the caption) ---------- */

async function readQrCommand(sock, chatId, message) {
    try {
        const quoted = getQuoted(message);
        const imageMsg = quoted?.imageMessage || message.message?.imageMessage || null;

        if (!imageMsg) {
            await sock.sendMessage(chatId, {
                text: '*Usage:* Reply to a photo containing a QR code with *.readqr*\n(or send the photo with *.readqr* as the caption).',
                ...channelInfo
            }, { quoted: message });
            return;
        }

        const buffer = await downloadImage(imageMsg);
        const data = await decodeQr(buffer);

        if (!data) {
            await sock.sendMessage(chatId, {
                text: '❌ No QR code found. Try a clearer, closer photo with the whole code visible.',
                ...channelInfo
            }, { quoted: message });
            return;
        }

        const isUrl = /^https?:\/\//i.test(data);
        await sock.sendMessage(chatId, {
            text: `✅ *QR code content:*\n\n${data}${isUrl ? '\n\n⚠️ _Only open links you trust._' : ''}`,
            ...channelInfo
        }, { quoted: message });

    } catch (error) {
        console.error('Error in readqr command:', error);
        await sock.sendMessage(chatId, { text: '❌ Failed to read that image. Please try again.', ...channelInfo }, { quoted: message });
    }
}

module.exports = { qrCommand, readQrCommand };
