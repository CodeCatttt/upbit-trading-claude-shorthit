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

// Extract DEFAULT_CONFIG block to scope replacements
const configStart = code.indexOf('const DEFAULT_CONFIG');
const configEnd = configStart >= 0 ? code.indexOf('};', configStart) + 2 : -1;

if (configStart < 0 || configEnd <= configStart) {
    console.error('  ERROR: DEFAULT_CONFIG not found in strategy file');
    process.exit(1);
}

let configBlock = code.slice(configStart, configEnd);
const beforeConfig = code.slice(0, configStart);
const afterConfig = code.slice(configEnd);

// Replace values ONLY within DEFAULT_CONFIG block
// Supports nested keys (e.g. "smartEntry.rsiThreshold") and string values (e.g. "executionMode": "smart")
for (const [key, value] of Object.entries(params)) {
    const leafKey = key.includes('.') ? key.split('.').pop() : key;
    const isString = typeof value === 'string';

    let replaced = false;
    if (isString) {
        const strRegex = new RegExp("(" + leafKey + "\\s*:\\s*)['\"]([^'\"]*)['\"]");
        if (strRegex.test(configBlock)) {
            configBlock = configBlock.replace(strRegex, "$1'" + value + "'");
            replaced = true;
        }
    }

    if (!replaced) {
        const numRegex = new RegExp('(' + leafKey + '\\s*:\\s*)([\\d.]+)');
        if (numRegex.test(configBlock)) {
            configBlock = configBlock.replace(numRegex, '$1' + value);
            replaced = true;
        }
    }

    // Also match boolean values: key: true or key: false
    if (!replaced) {
        const boolRegex = new RegExp('(' + leafKey + '\\s*:\\s*)(true|false)');
        if (boolRegex.test(configBlock)) {
            configBlock = configBlock.replace(boolRegex, '$1' + value);
            replaced = true;
        }
    }

    if (replaced) {
        console.log('  Updated ' + key + ' = ' + value);
    } else {
        console.log('  WARNING: key ' + key + ' not found in DEFAULT_CONFIG');
    }
}

code = beforeConfig + configBlock + afterConfig;

fs.writeFileSync(targetPath, code);
console.log('  Strategy parameters updated: ' + targetPath);
