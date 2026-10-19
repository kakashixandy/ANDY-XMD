const fs = require('fs');
const path = require('path');

// Economy store: one account per USER (not per chat), saved to disk so it survives restarts.
const DATA_FILE = path.join(__dirname, 'data', 'economy.json');
const accounts = new Map(); // jid -> { wallet, bank, inventory, cooldowns, partner, marriedAt, debts: [] }

// Pending requests (not saved, expire after 5 min)
const pendingMarry = new Map(); // targetJid -> { from, expires }
const pendingLoans = new Map(); // id -> { type: 'borrow'|'lend', from, to, amount, expires }

const STARTING_BALANCE = 200000;
const LOAN_INTEREST = 0.10;              // 10% flat interest
const LOAN_DURATION = 7 * 60 * 60 * 1000; // 7 hours to repay
const POLICE_FEE_RATE = 0.10;             // police charges = 10% of the remaining debt
const POLICE_FEE_MIN = 500;               // ...but never less than this
const SUE_COOLDOWN = 60 * 60 * 1000;      // a lender can sue the same debt once per hour
const REQUEST_TTL = 5 * 60 * 1000;

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

/* ===================== STORAGE ===================== */

function normalizeJid(jid) {
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) return jid;
    const [user, server] = jid.split('@');
    return `${user.split(':')[0]}@${server}`; // strips device suffix like ":12"
}

function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        for (const [jid, acc] of Object.entries(raw)) {
            accounts.set(jid, {
                wallet: acc.wallet ?? 0,
                bank: acc.bank ?? 0,
                inventory: acc.inventory || {},
                cooldowns: acc.cooldowns || {},
                partner: acc.partner || null,
                marriedAt: acc.marriedAt || null,
                debts: acc.debts || [],
            });
        }
    } catch (e) {
        console.error('Failed to load economy data:', e);
    }
}

let saveTimer = null;
function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
            fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(accounts)));
        } catch (e) {
            console.error('Failed to save economy data:', e);
        }
    }, 1000);
}

loadData();

function getAccount(jid) {
    jid = normalizeJid(jid);
    if (!accounts.has(jid)) {
        accounts.set(jid, {
            wallet: STARTING_BALANCE,
            bank: 0,
            inventory: {},
            cooldowns: {},
            partner: null,
            marriedAt: null,
            debts: [],
        });
    }
    return accounts.get(jid);
}

function hasAccount(jid) {
    return accounts.has(normalizeJid(jid));
}

function getBalance(jid) {
    return getAccount(jid).wallet;
}

function setBalance(jid, amount) {
    getAccount(jid).wallet = amount;
}

/* ===================== HELPERS ===================== */

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
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

function fmt(n) {
    return Math.floor(n).toLocaleString();
}

function tag(jid) {
    return `@${jid.split('@')[0]}`;
}

async function reply(sock, chatId, message, text) {
    await sock.sendMessage(chatId, { text }, { quoted: message });
}

async function replyMention(sock, chatId, message, text, mentions) {
    await sock.sendMessage(chatId, { text, mentions }, { quoted: message });
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

function parseAmount(args) {
    const first = (args || '').trim().split(/\s+/)[0];
    const n = parseInt(first, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function cleanExpired() {
    const now = Date.now();
    for (const [k, v] of pendingMarry) if (v.expires < now) pendingMarry.delete(k);
    for (const [k, v] of pendingLoans) if (v.expires < now) pendingLoans.delete(k);
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
            `🎉 *Welcome to the economy!*\n\n💰 You've been given *${fmt(STARTING_BALANCE)} coins* to start.\n` +
            `🌍 Your account works in *every chat*.\n\n` +
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

/* ===================== PROFILE ===================== */

async function profileCommand(sock, chatId, message, senderId, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const targetJid = (mentionedJid && mentionedJid[0]) || senderId;
        if (!hasAccount(targetJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }

        const acc = getAccount(targetJid);
        const isSelf = targetJid === senderId;
        const mentions = [targetJid];

        let text = `👤 *Profile* — ${tag(targetJid)}\n\n`;
        text += `💰 Wallet: *${fmt(acc.wallet)}*\n🏦 Bank: *${fmt(acc.bank)}*\n💵 Net Worth: *${fmt(acc.wallet + acc.bank)}*\n\n`;

        // Partner
        if (acc.partner) {
            mentions.push(acc.partner);
            const since = acc.marriedAt ? ` (for ${formatTime(Date.now() - acc.marriedAt)})` : '';
            text += `💍 Partner: ${tag(acc.partner)}${since}\n\n`;
        } else {
            text += `💍 Partner: _Single_\n\n`;
        }

        // Inventory
        const owned = Object.keys(acc.inventory).filter(id => acc.inventory[id]);
        text += `📦 Items: ${owned.length ? owned.map(id => SHOP_ITEMS[id]?.name || id).join(', ') : '_none_'}\n\n`;

        // Debts (what they owe)
        const now = Date.now();
        if (acc.debts.length) {
            text += `📉 *Debts (you owe)*\n`;
            for (const d of acc.debts) {
                mentions.push(d.lender);
                const left = d.due - now;
                const status = left > 0 ? `due in ${formatTime(left)}` : `⚠️ OVERDUE by ${formatTime(-left)}`;
                text += `• ${fmt(d.owed)} to ${tag(d.lender)} — ${status}\n`;
            }
            text += '\n';
        } else {
            text += `📉 Debts: _none_\n\n`;
        }

        // Receivables (what others owe them)
        const receivables = [];
        for (const [jid, other] of accounts) {
            for (const d of other.debts) {
                if (d.lender === targetJid) receivables.push({ borrower: jid, ...d });
            }
        }
        if (receivables.length) {
            text += `📈 *Owed to you*\n`;
            for (const r of receivables) {
                mentions.push(r.borrower);
                const left = r.due - now;
                const status = left > 0 ? `due in ${formatTime(left)}` : `⚠️ OVERDUE`;
                text += `• ${tag(r.borrower)} owes ${fmt(r.owed)} — ${status}\n`;
            }
            text += '\n';
        }

        // Cooldowns
        text += `⏳ *Cooldowns*\n`;
        for (const key of Object.keys(COOLDOWNS)) {
            const last = acc.cooldowns[key] || 0;
            const remaining = (last + COOLDOWNS[key]) - now;
            text += remaining > 0 ? `• .${key}: ${formatTime(remaining)}\n` : `• .${key}: ✅ ready\n`;
        }

        await replyMention(sock, chatId, message, text.trim(), [...new Set(mentions)]);

    } catch (error) {
        console.error('Error in profile command:', error);
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
            await replyMention(sock, chatId, message, `🦹 You successfully robbed ${tag(targetJid)} and got away with *${fmt(stolen)}* coins!`, [targetJid]);
        } else {
            const fine = Math.min(Math.floor(robber.wallet * 0.15), 5000);
            const actualFine = Math.min(fine, robber.wallet);
            robber.wallet -= actualFine;
            target.wallet += actualFine;
            await replyMention(sock, chatId, message, `🚨 You got caught trying to rob ${tag(targetJid)}! You paid a fine of *${fmt(actualFine)}* coins to them.`, [targetJid]);
        }

    } catch (error) {
        console.error('Error in rob command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== PAY ===================== */

async function payCommand(sock, chatId, message, senderId, args, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const amount = parseAmount(args);
        const targetJid = mentionedJid && mentionedJid[0];

        if (!amount || !targetJid) {
            await reply(sock, chatId, message, '*Usage:* .pay <amount> @user');
            return;
        }
        if (targetJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot pay yourself.');
            return;
        }
        if (!hasAccount(targetJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }

        const acc = getAccount(senderId);
        if (amount > acc.wallet) {
            await reply(sock, chatId, message, `❌ You only have *${fmt(acc.wallet)}* in your wallet.`);
            return;
        }

        acc.wallet -= amount;
        getAccount(targetJid).wallet += amount;

        await replyMention(sock, chatId, message,
            `💸 You paid *${fmt(amount)}* coins to ${tag(targetJid)}.\n💰 Wallet: ${fmt(acc.wallet)}`, [targetJid]);

    } catch (error) {
        console.error('Error in pay command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== MARRIAGE ===================== */

async function marryCommand(sock, chatId, message, senderId, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        cleanExpired();

        const targetJid = mentionedJid && mentionedJid[0];
        if (!targetJid) {
            await reply(sock, chatId, message, '*Usage:* .marry @user');
            return;
        }
        if (targetJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot marry yourself.');
            return;
        }
        if (!hasAccount(targetJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }

        const me = getAccount(senderId);
        const them = getAccount(targetJid);

        if (me.partner) {
            await replyMention(sock, chatId, message, `❌ You're already married to ${tag(me.partner)}. Use *.divorce* first.`, [me.partner]);
            return;
        }
        if (them.partner) {
            await replyMention(sock, chatId, message, `❌ ${tag(targetJid)} is already married.`, [targetJid]);
            return;
        }

        pendingMarry.set(targetJid, { from: senderId, expires: Date.now() + REQUEST_TTL });

        await replyMention(sock, chatId, message,
            `💍 ${tag(senderId)} has proposed to ${tag(targetJid)}!\n\n${tag(targetJid)}, type *.acceptmarry* within 5 minutes to say yes.`,
            [senderId, targetJid]);

    } catch (error) {
        console.error('Error in marry command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function acceptMarryCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        cleanExpired();

        const proposal = pendingMarry.get(senderId);
        if (!proposal) {
            await reply(sock, chatId, message, '❌ You have no pending marriage proposals.');
            return;
        }

        const proposerJid = proposal.from;
        const me = getAccount(senderId);
        const proposer = getAccount(proposerJid);

        if (me.partner || proposer.partner) {
            pendingMarry.delete(senderId);
            await reply(sock, chatId, message, '❌ One of you is already married.');
            return;
        }

        me.partner = proposerJid;
        proposer.partner = senderId;
        me.marriedAt = proposer.marriedAt = Date.now();
        pendingMarry.delete(senderId);

        await replyMention(sock, chatId, message,
            `💒 *Congratulations!* ${tag(proposerJid)} and ${tag(senderId)} are now married! 🎉`,
            [proposerJid, senderId]);

    } catch (error) {
        console.error('Error in acceptmarry command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

async function divorceCommand(sock, chatId, message, senderId) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const me = getAccount(senderId);
        if (!me.partner) {
            await reply(sock, chatId, message, '❌ You\'re not married.');
            return;
        }

        const exJid = me.partner;
        if (hasAccount(exJid)) {
            const ex = getAccount(exJid);
            ex.partner = null;
            ex.marriedAt = null;
        }
        me.partner = null;
        me.marriedAt = null;

        await replyMention(sock, chatId, message,
            `💔 ${tag(senderId)} has divorced ${tag(exJid)}.`, [senderId, exJid]);

    } catch (error) {
        console.error('Error in divorce command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

/* ===================== LOANS ===================== */

function loanKey(type, from, to) {
    return `${type}:${from}:${to}`;
}

// .borrow <amount> @lender  -> you ask someone to lend you money
async function borrowCommand(sock, chatId, message, senderId, args, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        cleanExpired();

        const amount = parseAmount(args);
        const lenderJid = mentionedJid && mentionedJid[0];

        if (!amount || !lenderJid) {
            await reply(sock, chatId, message, '*Usage:* .borrow <amount> @user');
            return;
        }
        if (lenderJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot borrow from yourself.');
            return;
        }
        if (!hasAccount(lenderJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }
        if (amount < 100) {
            await reply(sock, chatId, message, '❌ Minimum loan is *100* coins.');
            return;
        }

        pendingLoans.set(loanKey('borrow', senderId, lenderJid), {
            type: 'borrow', from: senderId, to: lenderJid, amount, expires: Date.now() + REQUEST_TTL
        });

        const owed = Math.ceil(amount * (1 + LOAN_INTEREST));
        await replyMention(sock, chatId, message,
            `🏦 ${tag(senderId)} wants to borrow *${fmt(amount)}* coins from ${tag(lenderJid)}.\n` +
            `📈 Interest: *${LOAN_INTEREST * 100}%* → repay *${fmt(owed)}* within *${formatTime(LOAN_DURATION)}*.\n\n` +
            `${tag(lenderJid)}, type *.acceptborrow ${tag(senderId)}* to approve.`,
            [senderId, lenderJid]);

    } catch (error) {
        console.error('Error in borrow command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

// .lend <amount> @borrower -> you offer to lend someone money
async function lendCommand(sock, chatId, message, senderId, args, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        cleanExpired();

        const amount = parseAmount(args);
        const borrowerJid = mentionedJid && mentionedJid[0];

        if (!amount || !borrowerJid) {
            await reply(sock, chatId, message, '*Usage:* .lend <amount> @user');
            return;
        }
        if (borrowerJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot lend to yourself.');
            return;
        }
        if (!hasAccount(borrowerJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account yet.');
            return;
        }
        if (amount < 100) {
            await reply(sock, chatId, message, '❌ Minimum loan is *100* coins.');
            return;
        }
        if (amount > getAccount(senderId).wallet) {
            await reply(sock, chatId, message, `❌ You only have *${fmt(getAccount(senderId).wallet)}* in your wallet.`);
            return;
        }

        pendingLoans.set(loanKey('lend', senderId, borrowerJid), {
            type: 'lend', from: senderId, to: borrowerJid, amount, expires: Date.now() + REQUEST_TTL
        });

        const owed = Math.ceil(amount * (1 + LOAN_INTEREST));
        await replyMention(sock, chatId, message,
            `🤝 ${tag(senderId)} offers to lend *${fmt(amount)}* coins to ${tag(borrowerJid)}.\n` +
            `📈 Interest: *${LOAN_INTEREST * 100}%* → repay *${fmt(owed)}* within *${formatTime(LOAN_DURATION)}*.\n\n` +
            `${tag(borrowerJid)}, type *.acceptborrow ${tag(senderId)}* to accept.`,
            [senderId, borrowerJid]);

    } catch (error) {
        console.error('Error in lend command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

// .acceptborrow @user -> accept a loan request (as lender) or a loan offer (as borrower)
async function acceptBorrowCommand(sock, chatId, message, senderId, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;
        cleanExpired();

        const otherJid = mentionedJid && mentionedJid[0];
        if (!otherJid) {
            await reply(sock, chatId, message, '*Usage:* .acceptborrow @user');
            return;
        }

        // Either they asked to borrow from me, or they offered to lend to me
        const keyBorrow = loanKey('borrow', otherJid, senderId);
        const keyLend = loanKey('lend', otherJid, senderId);
        const key = pendingLoans.has(keyBorrow) ? keyBorrow : (pendingLoans.has(keyLend) ? keyLend : null);

        if (!key) {
            await reply(sock, chatId, message, '❌ No pending loan request/offer from that user.');
            return;
        }

        const req = pendingLoans.get(key);
        const lenderJid = req.type === 'borrow' ? req.to : req.from;
        const borrowerJid = req.type === 'borrow' ? req.from : req.to;

        const lender = getAccount(lenderJid);
        const borrower = getAccount(borrowerJid);

        if (lender.wallet < req.amount) {
            pendingLoans.delete(key);
            await replyMention(sock, chatId, message, `❌ ${tag(lenderJid)} no longer has *${fmt(req.amount)}* coins in their wallet.`, [lenderJid]);
            return;
        }

        const owed = Math.ceil(req.amount * (1 + LOAN_INTEREST));
        lender.wallet -= req.amount;
        borrower.wallet += req.amount;
        borrower.debts.push({
            lender: lenderJid,
            principal: req.amount,
            owed,
            due: Date.now() + LOAN_DURATION,
        });
        pendingLoans.delete(key);

        await replyMention(sock, chatId, message,
            `✅ *Loan approved!*\n${tag(lenderJid)} lent *${fmt(req.amount)}* coins to ${tag(borrowerJid)}.\n` +
            `📉 ${tag(borrowerJid)} owes *${fmt(owed)}* coins (incl. ${LOAN_INTEREST * 100}% interest), due in *${formatTime(LOAN_DURATION)}*.\n\n` +
            `Repay with *.repay <amount|all> @${lenderJid.split('@')[0]}*\n` +
            `⚠️ If it's late, the lender can *.sue* and the court will seize the money + police charges.`,
            [lenderJid, borrowerJid]);

    } catch (error) {
        console.error('Error in acceptborrow command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

// .repay @lender <amount|all>
async function repayCommand(sock, chatId, message, senderId, args, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const lenderJid = mentionedJid && mentionedJid[0];
        const parts = (args || '').trim().split(/\s+/);
        const wantsAll = parts.some(p => p.toLowerCase() === 'all');
        const amountArg = parts.map(p => parseInt(p, 10)).find(n => Number.isFinite(n) && n > 0);

        if (!lenderJid || (!wantsAll && !amountArg)) {
            await reply(sock, chatId, message, '*Usage:* .repay <amount|all> @user');
            return;
        }

        const me = getAccount(senderId);
        const debt = me.debts.find(d => d.lender === lenderJid);
        if (!debt) {
            await reply(sock, chatId, message, '❌ You don\'t owe that user anything.');
            return;
        }

        let pay = wantsAll ? debt.owed : amountArg;
        pay = Math.min(pay, debt.owed, me.wallet);
        if (pay <= 0) {
            await reply(sock, chatId, message, '❌ You don\'t have any coins in your wallet to repay with.');
            return;
        }

        me.wallet -= pay;
        if (hasAccount(lenderJid)) getAccount(lenderJid).wallet += pay;
        debt.owed -= pay;

        let text;
        if (debt.owed <= 0) {
            me.debts.splice(me.debts.indexOf(debt), 1);
            text = `✅ You repaid *${fmt(pay)}* coins to ${tag(lenderJid)}. Debt fully cleared! 🎉`;
        } else {
            text = `💸 You repaid *${fmt(pay)}* coins to ${tag(lenderJid)}.\n📉 Remaining debt: *${fmt(debt.owed)}*`;
        }

        await replyMention(sock, chatId, message, text, [lenderJid]);

    } catch (error) {
        console.error('Error in repay command:', error);
        await reply(sock, chatId, message, '❌ Something went wrong. Please try again.');
    }
}

// .sue @borrower -> force repayment of an OVERDUE loan (debt + police charges)
async function sueCommand(sock, chatId, message, senderId, mentionedJid = []) {
    try {
        if (!(await requireAccount(sock, chatId, message, senderId))) return;

        const borrowerJid = mentionedJid && mentionedJid[0];
        if (!borrowerJid) {
            await reply(sock, chatId, message, '*Usage:* .sue @user');
            return;
        }
        if (borrowerJid === senderId) {
            await reply(sock, chatId, message, '❌ You cannot sue yourself.');
            return;
        }
        if (!hasAccount(borrowerJid)) {
            await reply(sock, chatId, message, '❌ That user doesn\'t have an account.');
            return;
        }

        const borrower = getAccount(borrowerJid);
        const debt = borrower.debts.find(d => d.lender === senderId);
        if (!debt) {
            await replyMention(sock, chatId, message, `❌ ${tag(borrowerJid)} doesn't owe you anything.`, [borrowerJid]);
            return;
        }

        const now = Date.now();
        if (debt.due > now) {
            await replyMention(sock, chatId, message,
                `⚖️ You can't sue yet. ${tag(borrowerJid)} still has *${formatTime(debt.due - now)}* to repay.`, [borrowerJid]);
            return;
        }
        if (debt.suedAt && now - debt.suedAt < SUE_COOLDOWN) {
            await reply(sock, chatId, message,
                `⏳ You already sued over this debt. You can sue again in *${formatTime(SUE_COOLDOWN - (now - debt.suedAt))}*.`);
            return;
        }

        const lender = getAccount(senderId);
        const policeFee = Math.max(POLICE_FEE_MIN, Math.ceil(debt.owed * POLICE_FEE_RATE));
        const totalDue = debt.owed + policeFee;

        // Seize from wallet first, then bank (a Lockbox protects 20% of the bank)
        const bankSeizable = Math.floor(borrower.bank * (borrower.inventory.lockbox ? 0.8 : 1));
        const fromWallet = Math.min(borrower.wallet, totalDue);
        const fromBank = Math.min(bankSeizable, totalDue - fromWallet);
        const seized = fromWallet + fromBank;

        borrower.wallet -= fromWallet;
        borrower.bank -= fromBank;

        // Lender is paid first; whatever is left covers the police charges
        const toLender = Math.min(seized, debt.owed);
        const toPolice = seized - toLender;
        lender.wallet += toLender;
        debt.owed -= toLender;
        debt.suedAt = now;

        let text = `⚖️ *COURT ORDER* ⚖️\n${tag(senderId)} sued ${tag(borrowerJid)} for an overdue loan.\n\n` +
            `🚔 Police charges: *${fmt(policeFee)}*\n` +
            `💰 Seized: *${fmt(seized)}* of *${fmt(totalDue)}* (wallet ${fmt(fromWallet)}, bank ${fmt(fromBank)})\n` +
            `📥 Paid to ${tag(senderId)}: *${fmt(toLender)}*\n` +
            `👮 Paid to police: *${fmt(toPolice)}*\n`;

        if (debt.owed <= 0) {
            borrower.debts.splice(borrower.debts.indexOf(debt), 1);
            text += `\n✅ Debt fully cleared.`;
        } else {
            text += `\n📉 ${tag(borrowerJid)} still owes *${fmt(debt.owed)}* (not enough funds to seize). You can sue again in ${formatTime(SUE_COOLDOWN)}.`;
        }

        await replyMention(sock, chatId, message, text, [senderId, borrowerJid]);

    } catch (error) {
        console.error('Error in sue command:', error);
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

/* ===================== EXPORTS ===================== */

// Wraps every command so that:
//  - the sender (and any @mentions) are normalized to ONE id per user → same account in every chat
//  - data is saved to disk after each command
function wrap(fn) {
    return async (...a) => {
        if (a[3]) a[3] = normalizeJid(a[3]);
        for (let i = 4; i < a.length; i++) {
            if (Array.isArray(a[i])) a[i] = a[i].map(normalizeJid);
        }
        const result = await fn(...a);
        saveSoon();
        return result;
    };
}

module.exports = {
    startCommand: wrap(startCommand),
    balanceCommand: wrap(balanceCommand),
    profileCommand: wrap(profileCommand),
    depositCommand: wrap(depositCommand),
    withdrawCommand: wrap(withdrawCommand),
    dailyCommand: wrap(dailyCommand),
    weeklyCommand: wrap(weeklyCommand),
    workCommand: wrap(workCommand),
    begCommand: wrap(begCommand),
    crimeCommand: wrap(crimeCommand),
    searchCommand: wrap(searchCommand),
    fishCommand: wrap(fishCommand),
    huntCommand: wrap(huntCommand),
    slotsCommand: wrap(slotsCommand),
    blackjackCommand: wrap(blackjackCommand),
    robCommand: wrap(robCommand),
    payCommand: wrap(payCommand),
    marryCommand: wrap(marryCommand),
    acceptMarryCommand: wrap(acceptMarryCommand),
    divorceCommand: wrap(divorceCommand),
    borrowCommand: wrap(borrowCommand),
    lendCommand: wrap(lendCommand),
    acceptBorrowCommand: wrap(acceptBorrowCommand),
    repayCommand: wrap(repayCommand),
    sueCommand: wrap(sueCommand),
    shopCommand: wrap(shopCommand),
    buyCommand: wrap(buyCommand),
    inventoryCommand: wrap(inventoryCommand),
    leaderboardCommand: wrap(leaderboardCommand),
    getBalance,
    setBalance
};
