const TicTacToe = require('../lib/tictactoe');

// Store games globally: roomId -> room
const games = {};

const SYMBOL_MAP = {
    'X': '❎', 'O': '⭕',
    '1': '1️⃣', '2': '2️⃣', '3': '3️⃣',
    '4': '4️⃣', '5': '5️⃣', '6': '6️⃣',
    '7': '7️⃣', '8': '8️⃣', '9': '9️⃣',
};

const WARNING_MS = 30 * 1000;        // warn at 30s of inactivity (playing)
const TERMINATE_MS = 2 * 60 * 1000;  // terminate at 2 minutes of inactivity (playing)
const WAITING_EXPIRY_MS = 2 * 60 * 1000; // cancel if nobody joins within 2 minutes

function renderBoard(room) {
    return room.game.render().map(v => SYMBOL_MAP[v]);
}

// Only ONE game (waiting or playing) allowed per chat at a time
function findActiveRoomInChat(chatId) {
    return Object.values(games).find(room =>
        room.id.startsWith('tictactoe') && room.x === chatId
    );
}

function clearRoomTimers(room) {
    if (room.warnTimeout) clearTimeout(room.warnTimeout);
    if (room.endTimeout) clearTimeout(room.endTimeout);
    if (room.waitTimeout) clearTimeout(room.waitTimeout);
    room.warnTimeout = null;
    room.endTimeout = null;
    room.waitTimeout = null;
}

function scheduleWaitingExpiry(sock, room) {
    clearRoomTimers(room);
    room.waitTimeout = setTimeout(async () => {
        try {
            await sock.sendMessage(room.x, {
                text: `⌛ No one joined the game. It has been cancelled.\nType *.ttt start* to try again.`
            });
        } catch {}
        delete games[room.id];
    }, WAITING_EXPIRY_MS);
}

function scheduleInactivityTimer(sock, room) {
    clearRoomTimers(room);
    if (room.state !== 'PLAYING') return;

    const turnPlayer = room.game.currentTurn;

    room.warnTimeout = setTimeout(async () => {
        try {
            await sock.sendMessage(room.x, {
                text: `⏰ @${turnPlayer.split('@')[0]}, you have *30 seconds* left to move or the game will be auto-terminated!`,
                mentions: [turnPlayer]
            });
        } catch {}
    }, TERMINATE_MS - WARNING_MS);

    room.endTimeout = setTimeout(async () => {
        const opponent = turnPlayer === room.game.playerX ? room.game.playerO : room.game.playerX;
        try {
            await sock.sendMessage(room.x, {
                text: `⌛ @${turnPlayer.split('@')[0]} took too long to respond.\n🏆 @${opponent.split('@')[0]} wins by inactivity!`,
                mentions: [turnPlayer, opponent]
            });
        } catch {}
        clearRoomTimers(room);
        delete games[room.id];
    }, TERMINATE_MS);
}

/**
 * Main dispatcher: .ttt, .ttt start, .ttt join,
 * .ttt @user (direct challenge), .ttt surrender, .ttt stop
 */
async function tictactoeCommand(sock, chatId, senderId, args, mentionedJid = []) {
    try {
        const sub = (args || '').trim().split(/\s+/)[0]?.toLowerCase();

        if (sub === 'surrender') {
            return await surrenderGame(sock, chatId, senderId);
        }

        if (sub === 'stop') {
            return await stopGame(sock, chatId, senderId);
        }

        if (sub === 'join') {
            return await joinGame(sock, chatId, senderId);
        }

        // Direct challenge: .ttt @user
        if (mentionedJid && mentionedJid.length > 0) {
            return await startDirectChallenge(sock, chatId, senderId, mentionedJid[0]);
        }

        // .ttt or .ttt start
        return await startGame(sock, chatId, senderId);

    } catch (error) {
        console.error('Error in tictactoe command:', error);
        await sock.sendMessage(chatId, {
            text: '❌ Error processing tictactoe command. Please try again.'
        });
    }
}

async function startGame(sock, chatId, senderId) {
    const active = findActiveRoomInChat(chatId);
    if (active) {
        const msg = active.state === 'WAITING'
            ? '❌ A game is already waiting for an opponent here. Type *.ttt join* to play!'
            : '❌ A game is already in progress in this group. Wait for it to finish, or an involved player can type *.ttt stop*.';
        await sock.sendMessage(chatId, { text: msg });
        return;
    }

    const room = {
        id: 'tictactoe-' + (+new Date),
        x: chatId,
        game: new TicTacToe(senderId, 'o'),
        state: 'WAITING',
        createdBy: senderId
    };
    games[room.id] = room;

    await sock.sendMessage(chatId, {
        text: `⏳ *Waiting for opponent*\nType *.ttt join* to play!\n\nOr tag someone directly: *.ttt @user*`
    });

    scheduleWaitingExpiry(sock, room);
}

async function joinGame(sock, chatId, senderId) {
    const room = findActiveRoomInChat(chatId);

    if (!room || room.state !== 'WAITING') {
        await sock.sendMessage(chatId, {
            text: '❌ No waiting game found here. Start one with *.ttt start*'
        });
        return;
    }

    if (room.game.playerX === senderId) {
        await sock.sendMessage(chatId, { text: '❌ You cannot join your own game.' });
        return;
    }

    room.game.playerO = senderId;
    room.state = 'PLAYING';

    const arr = renderBoard(room);
    const str = `
🎮 *TicTacToe Game Started!*

Waiting for @${room.game.currentTurn.split('@')[0]} to play...

${arr.slice(0, 3).join('')}
${arr.slice(3, 6).join('')}
${arr.slice(6).join('')}

▢ ❎ @${room.game.playerX.split('@')[0]}
▢ ⭕ @${room.game.playerO.split('@')[0]}
▢ *Rules:* Type 1-9 to play. *.ttt surrender* to quit.
`;

    await sock.sendMessage(chatId, {
        text: str,
        mentions: [room.game.currentTurn, room.game.playerX, room.game.playerO]
    });

    scheduleInactivityTimer(sock, room);
}

async function startDirectChallenge(sock, chatId, senderId, opponentJid) {
    if (opponentJid === senderId) {
        await sock.sendMessage(chatId, { text: '❌ You cannot challenge yourself.' });
        return;
    }

    const active = findActiveRoomInChat(chatId);
    if (active) {
        const msg = active.state === 'WAITING'
            ? '❌ A game is already waiting for an opponent here. Type *.ttt join* to play!'
            : '❌ A game is already in progress in this group. Wait for it to finish, or an involved player can type *.ttt stop*.';
        await sock.sendMessage(chatId, { text: msg });
        return;
    }

    const room = {
        id: 'tictactoe-' + (+new Date),
        x: chatId,
        game: new TicTacToe(senderId, 'o'),
        state: 'PLAYING',
        createdBy: senderId
    };
    room.game.playerO = opponentJid;
    games[room.id] = room;

    const arr = renderBoard(room);
    const str = `
🎮 *TicTacToe Challenge!*

@${senderId.split('@')[0]} challenged @${opponentJid.split('@')[0]}!

${arr.slice(0, 3).join('')}
${arr.slice(3, 6).join('')}
${arr.slice(6).join('')}

▢ ❎ @${room.game.playerX.split('@')[0]}
▢ ⭕ @${room.game.playerO.split('@')[0]}
▢ Turn: @${room.game.currentTurn.split('@')[0]}
▢ *Rules:* Type 1-9 to play. *.ttt surrender* to quit.
`;

    await sock.sendMessage(chatId, {
        text: str,
        mentions: [senderId, opponentJid, room.game.currentTurn]
    });

    scheduleInactivityTimer(sock, room);
}

async function surrenderGame(sock, chatId, senderId) {
    const room = findActiveRoomInChat(chatId);

    if (!room || room.state !== 'PLAYING' || ![room.game.playerX, room.game.playerO].includes(senderId)) {
        await sock.sendMessage(chatId, { text: '❌ You have no active game here.' });
        return;
    }

    const winner = senderId === room.game.playerX ? room.game.playerO : room.game.playerX;

    await sock.sendMessage(chatId, {
        text: `🏳️ @${senderId.split('@')[0]} surrendered!\n🏆 @${winner.split('@')[0]} wins!`,
        mentions: [senderId, winner]
    });

    clearRoomTimers(room);
    delete games[room.id];
}

async function stopGame(sock, chatId, senderId) {
    const room = findActiveRoomInChat(chatId);

    if (!room) {
        await sock.sendMessage(chatId, { text: '❌ There is no game to stop here.' });
        return;
    }

    const isParty = room.game.playerX === senderId || room.game.playerO === senderId || room.createdBy === senderId;
    if (!isParty) {
        await sock.sendMessage(chatId, { text: '❌ Only the players (or the creator) can stop this game.' });
        return;
    }

    clearRoomTimers(room);
    delete games[room.id];

    await sock.sendMessage(chatId, {
        text: `🛑 Game cancelled by @${senderId.split('@')[0]}. No winner declared.`,
        mentions: [senderId]
    });
}

async function handleTicTacToeMove(sock, chatId, senderId, text) {
    try {
        const room = findActiveRoomInChat(chatId);

        if (!room || room.state !== 'PLAYING' || ![room.game.playerX, room.game.playerO].includes(senderId)) {
            return;
        }

        if (!/^[1-9]$/.test(text)) return;

        if (senderId !== room.game.currentTurn) {
            await sock.sendMessage(chatId, { text: '❌ Not your turn!' });
            return;
        }

        const ok = room.game.turn(senderId === room.game.playerO, parseInt(text) - 1) === 1;

        if (!ok) {
            await sock.sendMessage(chatId, { text: '❌ Invalid move! Position already taken.' });
            return;
        }

        clearRoomTimers(room);

        const winner = room.game.winner;
        const isTie = room.game.turns === 9;
        const arr = renderBoard(room);

        let gameStatus;
        if (winner) {
            gameStatus = `🎉 @${winner.split('@')[0]} wins!`;
        } else if (isTie) {
            gameStatus = `🤝 Draw game!`;
        } else {
            gameStatus = `🎲 Turn: @${room.game.currentTurn.split('@')[0]}`;
        }

        const str = `
🎮 *TicTacToe*

${gameStatus}

${arr.slice(0, 3).join('')}
${arr.slice(3, 6).join('')}
${arr.slice(6).join('')}

▢ ❎ @${room.game.playerX.split('@')[0]}
▢ ⭕ @${room.game.playerO.split('@')[0]}

${!winner && !isTie ? 'Type 1-9 to play, *.ttt surrender*, or *.ttt stop*' : 'Type *.ttt start* to play again!'}
`;

        const mentions = [
            room.game.playerX,
            room.game.playerO,
            ...(winner ? [winner] : [room.game.currentTurn])
        ];

        await sock.sendMessage(chatId, { text: str, mentions });

        if (winner || isTie) {
            delete games[room.id];
        } else {
            scheduleInactivityTimer(sock, room);
        }

    } catch (error) {
        console.error('Error in tictactoe move:', error);
    }
}

module.exports = {
    tictactoeCommand,
    handleTicTacToeMove
};