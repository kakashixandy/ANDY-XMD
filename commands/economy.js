// In-memory economy store (temporary — will be swapped for Google Sheets storage later)
// Resets whenever the bot restarts.
const accounts = new Map(); // jid -> { wallet, bank, inventory: {}, cooldowns: {} }

const STARTING_BALANCE = 200000;

const COOLDOWNS = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    work: 60 * 60 * 1000,
    beg: 30 * 1000,
    crime: 2 * 60 * 1000,
    fish: 45 * 1000,
    hunt: 60 * 1000,
    search: 30 * 1000,
    rob: 60 * 60 * 1000,
};

const SHOP_ITEMS = {
    fishingrod: { name: '🎣 Fishing Rod', price: 5000, desc: 'Required to use .fish' },
    huntingrifle: { name: '🔫 Hunting Rifle', price: 8000, desc: 'Required to use .hunt' },
    lockbox: { name: '🔒 Lockbox', price: 15000, desc: 'Protects 20% of your bank from being robbed' },
};

function getAccount(jid) {
    if (!accounts.has(jid)) {
        accounts.set(jid, {
            wallet: STARTING_BALANCE,
            bank: 0,
            inventory: {},
            cooldowns: {}
        });
    }
    return accounts.get(jid);
}

function hasAccount(jid) {
    return accounts.has(jid);
}

function getBalance(jid) {
    return getAccount(jid).wallet;
}

function setBalance(jid, amount) {
    getAccount(jid).wallet = amount;
}

function onCooldown(jid, key) {
    const acc = getAccount(jid);
    const last = acc.cooldowns[key] || 0;
    const remaining = (last + COOLDOWNS[key]) - Date.now();
    return remaining > 0 ? remaining : 0;
}

function setCooldown(jid, key) {
    getAccount(jid).cooldowns[key] = Date.now();
}

function formatTime(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

function fmt(n) {
    return Math.floor(n).toLocaleString();
}

async function reply(sock, chatId, message, text) {
    await sock.sendMessage(chatId, { text }, { quoted: message });
}

async function requireAccount(sock, chatId, message, senderId) {
    if (!hasAccount(senderId)) {
        await reply(sock, chatId, message, '❌ You don\'t have an account yet. Type *.start* to get your first *200,000 coins*!');
        return false;
    }
    return true;
}

async function requireCooldown(sock, chatId, message, senderId, key, label) {
    const remaining = onCooldown(senderId, key);
    if (remaining > 0) {
        await reply(sock, chatId, message, `⏳ *${label}* is on cooldown. Try again in *${formatTime(remaining)}*.`);
        return false;
    }
    return true;
}

/* ===================== ACCOUNT ===================== */

async function startCommand(sock, chatId, message, senderId) {
    try {
        if (hasAccount(senderId)) {
            const acc = getAccount(senderId);
            await reply(sock, chatId, message,
                `ℹ️ You already have an account!\n💰 Wallet: *${fmt(acc.wallet)}*\n🏦 Bank: *${fmt(acc.bank)}*`);
            return;
        }

        getAccount(senderId); // creates with starting balance

        await reply(sock, chatId, message,
            `🎉 *Welcome to the economy!*\n\n💰 You've been given *${fmt(STARTING_BALANCE)} coins* to start.\n\n` +
            `Type *.balance* to check your coins, or *.shop* to see what you can buy.`);

    } catch (error) {
        console.error('Error in start command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function balanceCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        await reply(sock, chatId, message,
            `💰 *Wallet:* ${fmt(acc.wallet)}\n🏦 *Bank:* ${fmt(acc.bank)}\n💵 *Net Worth:* ${fmt(acc.wallet + acc.bank)}`);

    } catch (error) {
        console.error('Error in balance command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== BANK ===================== */

async function depositCommand(sock, chatId, message, senderId, args) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        const input = (args || '').trim().toLowerCase();

        let amount;
        if (input === 'all') {
            amount = acc.wallet;
        } else {
            amount = parseInt(input, 10);
        }

        if (!amount || amount <= 0) {
            await reply(sock, chatId, message, '*Usage:* .deposit <amount> | .deposit all');
            return;
        }

        if (amount > acc.wallet) {
            await reply(sock, chatId, message, `❌ You only have *${fmt(acc.wallet)}* in your wallet.`);
            return;
        }

        acc.wallet -= amount;
        acc.bank += amount;

        await reply(sock, chatId, message,
            `✅ Deposited *${fmt(amount)}* coins.\n💰 Wallet: ${fmt(acc.wallet)}\n🏦 Bank: ${fmt(acc.bank)}`);

    } catch (error) {
        console.error('Error in deposit command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function withdrawCommand(sock, chatId, message, senderId, args) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        const input = (args || '').trim().toLowerCase();

        let amount;
        if (input === 'all') {
            amount = acc.bank;
        } else {
            amount = parseInt(input, 10);
        }

        if (!amount || amount <= 0) {
            await reply(sock, chatId, message, '*Usage:* .withdraw <amount> | .withdraw all');
            return;
        }

        if (amount > acc.bank) {
            await reply(sock, chatId, message, `❌ You only have *${fmt(acc.bank)}* in your bank.`);
            return;
        }

        acc.bank -= amount;
        acc.wallet += amount;

        await reply(sock, chatId, message,
            `✅ Withdrew *${fmt(amount)}* coins.\n💰 Wallet: ${fmt(acc.wallet)}\n🏦 Bank: ${fmt(acc.bank)}`);

    } catch (error) {
        console.error('Error in withdraw command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== MONEY MAKING ===================== */

async function dailyCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'daily', '.daily'))) return;

        const amount = 5000;
        getAccount(senderId).wallet += amount;
        setCooldown(senderId, 'daily');

        await reply(sock, chatId, message, `☀️ *Daily claimed!*\n💰 +${fmt(amount)} coins`);

    } catch (error) {
        console.error('Error in daily command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function weeklyCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'weekly', '.weekly'))) return;

        const amount = 25000;
        getAccount(senderId).wallet += amount;
        setCooldown(senderId, 'weekly');

        await reply(sock, chatId, message, `📅 *Weekly claimed!*\n💰 +${fmt(amount)} coins`);

    } catch (error) {
        console.error('Error in weekly command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function workCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'work', '.work'))) return;

        const jobs = [
            { job: 'plumber', min: 800, max: 2000 },
            { job: 'delivery driver', min: 600, max: 1800 },
            { job: 'street performer', min: 300, max: 1200 },
            { job: 'freelance coder', min: 1000, max: 2500 },
            { job: 'cashier', min: 500, max: 1500 },
        ];
        const pick = jobs[Math.floor(Math.random() * jobs.length)];
        const amount = Math.floor(Math.random() * (pick.max - pick.min + 1)) + pick.min;

        getAccount(senderId).wallet += amount;
        setCooldown(senderId, 'work');

        await reply(sock, chatId, message, `🛠️ You worked as a *${pick.job}* and earned *${fmt(amount)}* coins!`);

    } catch (error) {
        console.error('Error in work command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function begCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'beg', '.beg'))) return;

        setCooldown(senderId, 'beg');

        const success = Math.random() < 0.7;
        if (!success) {
            await reply(sock, chatId, message, `🙏 You begged, but nobody gave you anything this time.`);
            return;
        }

        const amount = Math.floor(Math.random() * 450) + 50;
        getAccount(senderId).wallet += amount;

        const givers = ['a kind stranger', 'an old lady', 'a passing tourist', 'a generous businessman'];
        const giver = givers[Math.floor(Math.random() * givers.length)];

        await reply(sock, chatId, message, `🙏 ${giver.charAt(0).toUpperCase() + giver.slice(1)} gave you *${fmt(amount)}* coins!`);

    } catch (error) {
        console.error('Error in beg command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function crimeCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'crime', '.crime'))) return;

        setCooldown(senderId, 'crime');
        const acc = getAccount(senderId);

        const success = Math.random() < 0.45;
        const crimes = ['robbed a store', 'hacked an ATM', 'pickpocketed a tourist', 'ran a scam'];
        const crime = crimes[Math.floor(Math.random() * crimes.length)];

        if (success) {
            const amount = Math.floor(Math.random() * 4000) + 1000;
            acc.wallet += amount;
            await reply(sock, chatId, message, `🕵️ You ${crime} and got away with *${fmt(amount)}* coins!`);
        } else {
            const fine = Math.floor(Math.random() * 1500) + 500;
            const actualFine = Math.min(fine, acc.wallet);
            acc.wallet -= actualFine;
            await reply(sock, chatId, message, `🚔 You got caught trying to commit a crime and paid a fine of *${fmt(actualFine)}* coins!`);
        }

    } catch (error) {
        console.error('Error in crime command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function searchCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        if (!(await requireCooldown(sock, chatId, message, senderId, 'search', '.search'))) return;

        setCooldown(senderId, 'search');

        const locations = ['the couch', 'an old jacket', 'a trash can', 'under the bed', 'a vending machine', 'the park'];
        const location = locations[Math.floor(Math.random() * locations.length)];

        const found = Math.random() < 0.6;
        if (!found) {
            await reply(sock, chatId, message, `🔍 You searched *${location}* but found nothing.`);
            return;
        }

        const amount = Math.floor(Math.random() * 600) + 100;
        getAccount(senderId).wallet += amount;

        await reply(sock, chatId, message, `🔍 You searched *${location}* and found *${fmt(amount)}* coins!`);

    } catch (error) {
        console.error('Error in search command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function fishCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        if (!acc.inventory.fishingrod) {
            await reply(sock, chatId, message, '❌ You need a *Fishing Rod* to fish! Buy one with *.buy fishingrod*');
            return;
        }

        if (!(await requireCooldown(sock, chatId, message, senderId, 'fish', '.fish'))) return;
        setCooldown(senderId, 'fish');

        const catches = [
            { name: 'old boot', value: 0 },
            { name: 'small fish', value: 200 },
            { name: 'big fish', value: 600 },
            { name: 'rare golden fish', value: 2000 },
        ];
        const weights = [0.2, 0.45, 0.25, 0.1];
        const r = Math.random();
        let cum = 0, result = catches[0];
        for (let i = 0; i < catches.length; i++) {
            cum += weights[i];
            if (r <= cum) { result = catches[i]; break; }
        }

        if (result.value === 0) {
            await reply(sock, chatId, message, `🎣 You caught an *${result.name}*... worthless.`);
            return;
        }

        acc.wallet += result.value;
        await reply(sock, chatId, message, `🎣 You caught a *${result.name}* and sold it for *${fmt(result.value)}* coins!`);

    } catch (error) {
        console.error('Error in fish command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function huntCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        if (!acc.inventory.huntingrifle) {
            await reply(sock, chatId, message, '❌ You need a *Hunting Rifle* to hunt! Buy one with *.buy huntingrifle*');
            return;
        }

        if (!(await requireCooldown(sock, chatId, message, senderId, 'hunt', '.hunt'))) return;
        setCooldown(senderId, 'hunt');

        const animals = [
            { name: 'rabbit', value: 300 },
            { name: 'deer', value: 900 },
            { name: 'boar', value: 1400 },
            { name: 'nothing', value: 0 },
        ];
        const weights = [0.3, 0.3, 0.15, 0.25];
        const r = Math.random();
        let cum = 0, result = animals[0];
        for (let i = 0; i < animals.length; i++) {
            cum += weights[i];
            if (r <= cum) { result = animals[i]; break; }
        }

        if (result.value === 0) {
            await reply(sock, chatId, message, `🔫 You went hunting but caught nothing.`);
            return;
        }

        acc.wallet += result.value;
        await reply(sock, chatId, message, `🔫 You hunted a *${result.name}* and sold it for *${fmt(result.value)}* coins!`);

    } catch (error) {
        console.error('Error in hunt command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== GAMBLING ===================== */

async function slotsCommand(sock, chatId, message, senderId, args) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        const amount = parseInt((args || '').trim(), 10);

        if (!amount || amount <= 0) {
            await reply(sock, chatId, message, '*Usage:* .slots <amount>');
            return;
        }
        if (amount < 100 || amount > 10000) {
            await reply(sock, chatId, message, '❌ Bet must be between *100* and *10,000* coins.');
            return;
        }
        if (amount > acc.wallet) {
            await reply(sock, chatId, message, `❌ You don't have *${fmt(amount)}* coins in your wallet.`);
            return;
        }

        const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣'];
        const spin = () => symbols[Math.floor(Math.random() * symbols.length)];
        const result = [spin(), spin(), spin()];

        acc.wallet -= amount;

        let multiplier = 0;
        if (result[0] === result[1] && result[1] === result[2]) {
            multiplier = result[0] === '7️⃣' ? 10 : 5;
        } else if (result[0] === result[1] || result[1] === result[2] || result[0] === result[2]) {
            multiplier = 1.5;
        }

        const winnings = Math.floor(amount * multiplier);
        acc.wallet += winnings;

        const line = result.join(' | ');
        if (multiplier > 0) {
            await reply(sock, chatId, message, `🎰 [ ${line} ]\n\n🎉 You won *${fmt(winnings)}* coins!`);
        } else {
            await reply(sock, chatId, message, `🎰 [ ${line} ]\n\n💸 You lost *${fmt(amount)}* coins.`);
        }

    } catch (error) {
        console.error('Error in slots command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function blackjackCommand(sock, chatId, message, senderId, args) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        const amount = parseInt((args || '').trim(), 10);

        if (!amount || amount <= 0) {
            await reply(sock, chatId, message, '*Usage:* .blackjack <amount>');
            return;
        }
        if (amount < 100 || amount > 20000) {
            await reply(sock, chatId, message, '❌ Bet must be between *100* and *20,000* coins.');
            return;
        }
        if (amount > acc.wallet) {
            await reply(sock, chatId, message, `❌ You don't have *${fmt(amount)}* coins in your wallet.`);
            return;
        }

        // Simplified single-draw blackjack: draw cards until stand (auto-stand at 17+), dealer plays basic strategy
        const drawCard = () => Math.min(Math.floor(Math.random() * 13) + 1, 10);

        function drawHand(standAt) {
            let total = 0;
            while (total < standAt) {
                total += drawCard();
            }
            return total;
        }

        const playerTotal = drawHand(17);
        const dealerTotal = drawHand(17);

        acc.wallet -= amount;

        let outcome;
        if (playerTotal > 21) {
            outcome = 'bust';
        } else if (dealerTotal > 21) {
            outcome = 'win';
        } else if (playerTotal > dealerTotal) {
            outcome = 'win';
        } else if (playerTotal === dealerTotal) {
            outcome = 'push';
        } else {
            outcome = 'lose';
        }

        let text = `🃏 *Blackjack*\nYour hand: ${playerTotal}\nDealer's hand: ${dealerTotal}\n\n`;

        if (outcome === 'win') {
            const winnings = amount * 2;
            acc.wallet += winnings;
            text += `🎉 You won *${fmt(winnings)}* coins!`;
        } else if (outcome === 'push') {
            acc.wallet += amount;
            text += `🤝 Push — your bet of *${fmt(amount)}* coins was returned.`;
        } else {
            text += `💸 You lost *${fmt(amount)}* coins.`;
        }

        await reply(sock, chatId, message, text);

    } catch (error) {
        console.error('Error in blackjack command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== ROB ===================== */

async function robCommand(sock, chatId, message, senderId, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        if (!mentionedJid || mentionedJid.length === 0) {
            await reply(sock, chatId, message, '*Usage:* .rob @user');
            return;
        }

        const targetJid = mentionedJid[0];
        if (targetJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot rob yourself.');
            return;
        }
        if (!hasAccount(targetJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }

        if (!(await requireCooldown(sock, chatId, message, senderId, 'rob', '.rob'))) return;

        const robber = getAccount(senderId);
        const target = getAccount(targetJid);

        if (target.wallet < 500) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have enough in their wallet to rob (minimum 500 coins).');
            return;
        }

        setCooldown(senderId, 'rob');

        const success = Math.random() < 0.4;

        if (success) {
            const stealPercent = 0.1 + Math.random() * 0.1; // 10-20%
            const stolen = Math.min(Math.floor(target.wallet * stealPercent), 10000);
            target.wallet -= stolen;
            robber.wallet += stolen;
            await reply(sock, chatId, message, `🦹 You successfully robbed @${targetJid.split('@')[0]} and got away with *${fmt(stolen)}* coins!`);
        } else {
            const fine = Math.min(Math.floor(robber.wallet * 0.15), 5000);
            const actualFine = Math.min(fine, robber.wallet);
            robber.wallet -= actualFine;
            target.wallet += actualFine;
            await reply(sock, chatId, message, `🚨 You got caught trying to rob @${targetJid.split('@')[0]}! You paid a fine of *${fmt(actualFine)}* coins to them.`);
        }

    } catch (error) {
        console.error('Error in rob command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== SHOP / INVENTORY ===================== */

async function shopCommand(sock, chatId, message) {
    try {
        let text = '🛒 *Shop*\n\n';
        for (const [id, item] of Object.entries(SHOP_ITEMS)) {
            text += `*${item.name}* — ${fmt(item.price)} coins\n_${item.desc}_\nID: \`${id}\`\n\n`;
        }
        text += 'Buy with *.buy <item id>*';
        await reply(sock, chatId, message, text);
    } catch (error) {
        console.error('Error in shop command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function buyCommand(sock, chatId, message, senderId, args) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const itemId = (args || '').trim().toLowerCase();
        const item = SHOP_ITEMS[itemId];

        if (!item) {
            await reply(sock, chatId, message, '❌ Item not found. Check *.shop* for valid item IDs.');
            return;
        }

        const acc = getAccount(senderId);
        if (acc.inventory[itemId]) {
            await reply(sock, chatId, message, '❌ You already own this item.');
            return;
        }

        if (acc.wallet < item.price) {
            await reply(sock, chatId, message, `❌ You need *${fmt(item.price)}* coins to buy this.`);
            return;
        }

        acc.wallet -= item.price;
        acc.inventory[itemId] = true;

        await reply(sock, chatId, message, `✅ You bought *${item.name}* for *${fmt(item.price)}* coins!`);

    } catch (error) {
        console.error('Error in buy command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function inventoryCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const acc = getAccount(senderId);
        const owned = Object.keys(acc.inventory).filter(id => acc.inventory[id]);

        if (owned.length === 0) {
            await reply(sock, chatId, message, '📦 Your inventory is empty. Check *.shop* to buy items.');
            return;
        }

        const text = '📦 *Your Inventory*\n\n' + owned.map(id => `• ${SHOP_ITEMS[id]?.name || id}`).join('\n');
        await reply(sock, chatId, message, text);

    } catch (error) {
        console.error('Error in inventory command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== LEADERBOARD ===================== */

async function leaderboardCommand(sock, chatId, message) {
    try {
        const all = Array.from(accounts.entries())
            .map(([jid, acc]) => ({ jid, net: acc.wallet + acc.bank }))
            .sort((a, b) => b.net - a.net)
            .slice(0, 10);

        if (all.length === 0) {
            await reply(sock, chatId, message, '📊 No accounts yet.');
            return;
        }

        let text = '🏆 *Richest Users*\n\n';
        all.forEach((entry, i) => {
            text += `${i + 1}. @${entry.jid.split('@')[0]} — ${fmt(entry.net)} coins\n`;
        });

        await sock.sendMessage(chatId, {
            text,
            mentions: all.map(e => e.jid)
        }, { quoted: message });

    } catch (error) {
        console.error('Error in leaderboard command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

module.exports = {
    startCommand,
    balanceCommand,
    depositCommand,
    withdrawCommand,
    dailyCommand,
    weeklyCommand,
    workCommand,
    begCommand,
    crimeCommand,
    searchCommand,
    fishCommand,
    huntCommand,
    slotsCommand,
    blackjackCommand,
    robCommand,
    shopCommand,
    buyCommand,
    inventoryCommand,
    leaderboardCommand,
    getBalance,
    setBalance
};