// Patches Baileys so group status media is tagged correctly.
// Safe by design: any problem is logged and the bot still starts.

try {
    const fs = require('fs');
    const path = require('path');

    // Find where Baileys is actually installed (works even if this file
    // lives somewhere unusual like node_modules/xcache/...)
    let baileysDir;
    try {
        const pkg = require.resolve('@whiskeysockets/baileys/package.json', {
            paths: [__dirname, process.cwd()]
        });
        baileysDir = path.dirname(pkg);
    } catch {
        console.warn('[PATCH] Baileys not found, patch skipped');
    }

    if (baileysDir) {
        const libDir = path.join(baileysDir, 'lib');
        const MARK = '/*gcstory-patch*/';
        const re = /(const getMediaType = \(message\) => \{)/;
        let found = 0;
        let patched = 0;

        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!p.endsWith('.js')) continue;

                let src = fs.readFileSync(p, 'utf8');
                if (!re.test(src)) continue;
                found++;
                if (src.includes(MARK)) continue;

                src = src.replace(
                    re,
                    `$1 ${MARK} message = message?.groupStatusMessageV2?.message || message;`
                );
                fs.writeFileSync(p, src);
                patched++;
                console.log('[PATCH] getMediaType patched in', p);
            }
        };

        if (fs.existsSync(libDir)) {
            walk(libDir);
            if (!found) console.warn('[PATCH] getMediaType not found, patch not applied');
            else if (!patched) console.log('[PATCH] already applied');
        } else {
            console.warn('[PATCH] lib folder not found at', libDir);
        }
    }
} catch (err) {
    console.warn('[PATCH] skipped due to error:', err.message);
}
