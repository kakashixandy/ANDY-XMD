
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const settings = require('../settings');

// Raw base link of your MAIN repo (must end with a slash)
const MAIN_RAW = 'https://raw.githubusercontent.com/andytech580/ANDY-XMD/main/';

// The bot runs from node_modules/xcache/..., the real project root is above node_modules
const ROOT = __dirname.split(`${path.sep}node_modules`)[0];

function normalize(jid = '') {
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isOwner(message, sock) {
    const sender = normalize(message.key.participant || message.key.remoteJid);
    const bot = normalize(sock.user?.id);
    if (message.key.fromMe || sender === bot) return true;

    const owners = []
        .concat(settings.ownerNumber || settings.owner || [])
        .flat()
        .map(normalize)
        .filter(Boolean);
    return owners.includes(sender);
}

function run(cmd, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).toString().slice(-300)));
            else resolve(stdout);
        });
    });
}

async function fetchMain(file) {
    return fetch(MAIN_RAW + file, { headers: { 'User-Agent': 'andy-xmd-update' } });
}

// Step 1: add missing packages. Returns the names that were added.
async function syncDependencies() {
    const res = await fetchMain('package.json');
    if (!res.ok) throw new Error(`Could not read main package.json (HTTP ${res.status})`);
    const remote = await res.json();

    const localPath = path.join(ROOT, 'package.json');
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    local.dependencies = local.dependencies || {};

    const added = [];
    for (const [name, version] of Object.entries(remote.dependencies || {})) {
        if (!local.dependencies[name]) {
            local.dependencies[name] = version;
            added.push(name);
        }
    }

    if (added.length) {
        fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
        await run('npm install --omit=dev --no-audit --no-fund', ROOT, 5 * 60 * 1000);
    }
    return added;
}

// Step 2: replace the loader if the main repo has a newer one. Returns true if replaced.
async function syncLoader() {
    const res = await fetchMain('index.js');
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Could not read main index.js (HTTP ${res.status})`);

    const remote = await res.text();
    if (remote.length < 200) throw new Error('main index.js looks empty, kept the old one');

    const target = path.join(ROOT, 'index.js');
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current.replace(/\r\n/g, '\n') === remote.replace(/\r\n/g, '\n')) return false;

    // Never install a broken loader: check the syntax first
    const tmp = path.join(ROOT, 'index.new.js');
    fs.writeFileSync(tmp, remote);
    try {
        await run(`node --check "${tmp}"`, ROOT, 20000);
    } catch {
        fs.unlinkSync(tmp);
        throw new Error('new index.js failed the syntax check, kept the old one');
    }

    if (current) fs.copyFileSync(target, path.join(ROOT, 'index.backup.js'));
    fs.renameSync(tmp, target);
    return true;
}

async function updateCommand(sock, chatId, message) {
    try {
        if (!isOwner(message, sock)) {
            await sock.sendMessage(chatId, {
                text: '❌ Only the bot owner can use this command.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: '🔄 *ANDY-XMD restarting, wait...*'
        }, { quoted: message });

        const notes = [];

        try {
            const added = await syncDependencies();
            if (added.length) notes.push(`📦 Installed packages: ${added.join(', ')}`);
        } catch (err) {
            console.error('[UPDATE] package sync failed:', err.message);
            notes.push(`⚠️ Package sync failed: ${err.message.slice(0, 120)}`);
        }

        try {
            if (await syncLoader()) notes.push('🧩 Loader (index.js) updated');
        } catch (err) {
            console.error('[UPDATE] loader sync failed:', err.message);
            notes.push(`⚠️ Loader update skipped: ${err.message.slice(0, 120)}`);
        }

        await sock.sendMessage(chatId, {
            text: `✅ Pulling the latest code from the fork now.${notes.length ? '\n\n' + notes.join('\n') : ''}\n\nBack in a moment.`
        }, { quoted: message });

        setTimeout(() => process.exit(1), 3000);
    } catch (error) {
        console.error('[UPDATE] failed:', error?.stack || error);
        await sock.sendMessage(chatId, {
            text: `❌ Update failed: ${error.message}`
        }, { quoted: message });
    }
}

module.exports = updateCommand;
