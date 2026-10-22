const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib');
const MARK = '/*gcstory-patch*/';
let patched = 0, found = 0;

(function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        let src = fs.readFileSync(p, 'utf8');
        const re = /(const getMediaType = \(message\) => \{)/;
        if (!re.test(src)) continue;
        found++;
        if (src.includes(MARK)) continue;
        src = src.replace(re, `$1 ${MARK} message = message?.groupStatusMessageV2?.message || message;`);
        fs.writeFileSync(p, src);
        patched++;
        console.log('[PATCH] getMediaType patched in', p);
    }
})(dir);

if (!found) console.warn('[PATCH] getMediaType not found, patch not applied');
else if (!patched) console.log('[PATCH] already applied');
