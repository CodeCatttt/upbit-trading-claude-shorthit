/**
 * apply-modify.js
 * Applies parameter modifications to the current strategy's DEFAULT_CONFIG.
 *
 * Usage: node apply-modify.js '{"lookback":240,"entryZScore":2.5}'
 */

'use strict';

const fs = require('fs');
const path = require('path');

const params = JSON.parse(process.argv[2]);
const strategyPath = 'src/strategies/current-strategy.js';
let code = fs.readFileSync(strategyPath, 'utf8');

// If re-export, resolve to actual file
const reExport = code.match(/module\.exports\s*=\s*require\(['"](\.\/[^'"]+)['"]\)/);
let targetPath = strategyPath;
if (reExport) {
    targetPath = path.resolve('src/strategies', reExport[1] + '.js');
    if (!fs.existsSync(targetPath)) targetPath = path.resolve('src/strategies', reExport[1]);
    code = fs.readFileSync(targetPath, 'utf8');
}

// Replace values in DEFAULT_CONFIG
for (const [key, value] of Object.entries(params)) {
    const regex = new RegExp('(' + key + '\\s*:\\s*)([\\d.]+)');
    if (regex.test(code)) {
        code = code.replace(regex, '$1' + value);
        console.log('  Updated ' + key + ' = ' + value);
    } else {
        console.log('  WARNING: key ' + key + ' not found in strategy');
    }
}

fs.writeFileSync(targetPath, code);
console.log('  Strategy parameters updated: ' + targetPath);
