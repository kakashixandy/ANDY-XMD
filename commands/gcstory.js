const {
    downloadMediaMessage,
    generateWAMessageContent,
    generateWAMessageFromContent,
    jidNormalizedUser,
    proto
} = require('@whiskeysockets/baileys');

const crypto = require('crypto');

async function gcstoryCommand(sock, chatId, message, xmdMessage) {
    
    try {
        

        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, {
                text: '❌ This command can only be used in groups.'
            }, { quoted: message });
            return;
        }

        const rawText =
            message.message?.conversation ||
            message.message?.extendedTextMessage?.text ||
            message.message?.imageMessage?.caption ||
            message.message?.videoMessage?.caption ||
            message.message?.documentMessage?.caption ||
            '';

        const caption = rawText.trim().split(/\s+/).slice(1).join(' ').trim();

        await sock.sendMessage(chatId, {
            react: { text: '⏳', key: message.key }
        });

        const messageSecret = crypto.randomBytes(32);
        let innerMessage;

        if (xmdMessage) {
            const quotedCtx = message.message?.extendedTextMessage?.contextInfo;
            const quotedContent = xmdMessage.message || xmdMessage;

            // Unwrap common WhatsApp wrappers
            let media = quotedContent;
            for (let i = 0; i < 6; i++) {
                const unwrapped =
                    media.ephemeralMessage?.message ||
                    media.viewOnceMessage?.message ||
                    media.viewOnceMessageV2?.message ||
                    media.viewOnceMessageV2Extension?.message ||
                    media.documentWithCaptionMessage?.message;
                if (!unwrapped) break;
                media = unwrapped;
            }

            const mediaType = media.imageMessage ? 'image'
                : media.videoMessage ? 'video'
                : media.audioMessage ? 'audio'
                : null;

            

            if (!mediaType) {
                throw new Error('The replied message is not a supported image, video, or audio.');
            }

            if (!xmdMessage.key && !quotedCtx?.stanzaId) {
                throw new Error('The command handler did not provide the quoted message key.');
            }

            const downloadMessage = {
                key: xmdMessage.key || {
                    remoteJid: chatId,
                    id: quotedCtx.stanzaId,
                    participant: quotedCtx.participant
                },
                message: quotedContent
            };

            

            const buffer = await downloadMediaMessage(
                downloadMessage,
                'buffer',
                {},
                { logger: console, reuploadRequest: sock.updateMediaMessage }
            );

            if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
                throw new Error('Downloaded media buffer is empty.');
            }

            
            let mediaContent;
            if (mediaType === 'image') {
                mediaContent = { image: buffer, caption };
            } else if (mediaType === 'video') {
                mediaContent = {
                    video: buffer,
                    caption,
                    mimetype: media.videoMessage.mimetype || 'video/mp4'
                };
            } else {
                mediaContent = {
                    audio: buffer,
                    mimetype: media.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                    ptt: Boolean(media.audioMessage.ptt)
                };
            }

            

            const inside = await generateWAMessageContent(
                mediaContent,
                { upload: sock.waUploadToServer }
            );

            

            innerMessage = {
                ...inside,
                messageContextInfo: { messageSecret }
            };
        } else {
            if (!caption) {
                throw new Error('Usage: Reply to media with .gcstory [caption], or send .gcstory <text>.');
            }

            

            innerMessage = {
                extendedTextMessage: {
                    text: caption,
                    font: 1,
                    backgroundArgb: 0xFFFF5733,
                    contextInfo: {
                        isGroupStatus: true,
                        statusAudienceMetadata: { audienceType: 1 }
                    }
                },
                messageContextInfo: { messageSecret }
            };
        }

        const content = proto.Message.fromObject({
            messageContextInfo: { messageSecret },
            groupStatusMessageV2: { message: innerMessage }
        });

        const generated = generateWAMessageFromContent(
            chatId,
            content,
            { userJid: jidNormalizedUser(sock.user.id) }
        );

        const result = await sock.relayMessage(
            chatId,
            generated.message,
            { messageId: generated.key.id }
        );

        

        await sock.sendMessage(chatId, {
            react: { text: '✅', key: message.key }
        });

    } catch (error) {
        console.error('[GCSTORY] FAILED:', error?.stack || error);

        try {
            await sock.sendMessage(chatId, {
                react: { text: '❌', key: message.key }
            });
            await sock.sendMessage(chatId, {
                text: `❌ Group status failed:\n${error?.message || String(error)}`
            }, { quoted: message });
        } catch (sendError) {
            console.error('[GCSTORY] Could not send error reply:', sendError);
        }
    }
}

module.exports = gcstoryCommand;
