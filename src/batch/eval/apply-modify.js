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
// Supports nested keys (e.g. "smartEntry.rsiThreshold") and string values (e.g. "executionMode": "smart")
for (const [key, value] of Object.entries(params)) {
    // For nested keys like "smartEntry.rsiThreshold", use the leaf key for matching
    const leafKey = key.includes('.') ? key.split('.').pop() : key;
    const isString = typeof value === 'string';

    let replaced = false;
    if (isString) {
        // Match string values: key: 'value' or key: "value"
        const strRegex = new RegExp("(" + leafKey + "\\s*:\\s*)['\"]([^'\"]*)['\"]");
        if (strRegex.test(code)) {
            code = code.replace(strRegex, "$1'" + value + "'");
            replaced = true;
        }
    }

    if (!replaced) {
        // Match numeric values: key: 123 or key: 1.5
        const numRegex = new RegExp('(' + leafKey + '\\s*:\\s*)([\\d.]+)');
        if (numRegex.test(code)) {
            code = code.replace(numRegex, '$1' + value);
            replaced = true;
        }
    }

    if (replaced) {
        console.log('  Updated ' + key + ' = ' + value);
    } else {
        console.log('  WARNING: key ' + key + ' not found in strategy');
    }
}

fs.writeFileSync(targetPath, code);
console.log('  Strategy parameters updated: ' + targetPath);
