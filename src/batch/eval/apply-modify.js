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
const strategyPath = process.env.STRATEGY_PATH || 'src/strategies/scalping-strategy.js';
let code = fs.readFileSync(strategyPath, 'utf8');

// If re-export, resolve to actual file
const reExport = code.match(/module\.exports\s*=\s*require\(['"](\.\/[^'"]+)['"]\)/);
let targetPath = strategyPath;
if (reExport) {
    const reExportPath = reExport[1].replace(/\.js$/, '');
    targetPath = path.resolve('src/strategies', reExportPath + '.js');
    if (!fs.existsSync(targetPath)) targetPath = path.resolve('src/strategies', reExportPath);
    code = fs.readFileSync(targetPath, 'utf8');
}

// Extract DEFAULT_CONFIG block to scope replacements (handles nested objects)
const configStart = code.indexOf('const DEFAULT_CONFIG');
let configEnd = -1;
if (configStart >= 0) {
    let braceDepth = 0;
    let foundOpen = false;
    for (let ci = configStart; ci < code.length; ci++) {
        if (code[ci] === '{') { braceDepth++; foundOpen = true; }
        else if (code[ci] === '}') { braceDepth--; }
        if (foundOpen && braceDepth === 0) {
            configEnd = code[ci + 1] === ';' ? ci + 2 : ci + 1;
            break;
        }
    }
}

if (configStart < 0 || configEnd <= configStart) {
    console.error('  ERROR: DEFAULT_CONFIG not found in strategy file');
    process.exit(1);
}

let configBlock = code.slice(configStart, configEnd);
const beforeConfig = code.slice(0, configStart);
const afterConfig = code.slice(configEnd);

// Replace values ONLY within DEFAULT_CONFIG block
// Supports nested keys (e.g. "smartEntry.rsiThreshold") and string values (e.g. "executionMode": "smart")
let failCount = 0;
for (const [key, value] of Object.entries(params)) {
    const rawLeafKey = key.includes('.') ? key.split('.').pop() : key;
    const leafKey = rawLeafKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isBool = typeof value === 'boolean';
    const isString = typeof value === 'string';

    let replaced = false;

    // Boolean values first — prevents numeric regex from interfering
    if (isBool) {
        const boolRegex = new RegExp('(' + leafKey + '\\s*:\\s*)(true|false)');
        if (boolRegex.test(configBlock)) {
            configBlock = configBlock.replace(boolRegex, '$1' + String(value));
            replaced = true;
        }
    }

    // String values
    if (!replaced && isString) {
        const strRegex = new RegExp("(" + leafKey + "\\s*:\\s*)['\"]([^'\"]*)['\"]");
        if (strRegex.test(configBlock)) {
            configBlock = configBlock.replace(strRegex, "$1'" + value + "'");
            replaced = true;
        }
    }

    // Numeric values
    if (!replaced && !isBool) {
        const numRegex = new RegExp('(' + leafKey + '\\s*:\\s*)(-?[\\d.]+)');
        if (numRegex.test(configBlock)) {
            configBlock = configBlock.replace(numRegex, '$1' + value);
            replaced = true;
        }
    }

    // Fallback: try boolean match for string "true"/"false" values
    if (!replaced) {
        const boolRegex = new RegExp('(' + leafKey + '\\s*:\\s*)(true|false)');
        if (boolRegex.test(configBlock)) {
            configBlock = configBlock.replace(boolRegex, '$1' + String(value));
            replaced = true;
        }
    }

    if (replaced) {
        console.log('  Updated ' + key + ' = ' + value);
    } else {
        console.log('  WARNING: key ' + key + ' not found in DEFAULT_CONFIG');
        failCount++;
    }
}

code = beforeConfig + configBlock + afterConfig;

// Atomic write: tmp + rename to prevent corruption
const tmpPath = targetPath + '.tmp';
fs.writeFileSync(tmpPath, code);

// Verify the write succeeded by reading back
const verifyCode = fs.readFileSync(tmpPath, 'utf8');
if (verifyCode !== code) {
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error('  ERROR: File verification failed — written content does not match');
    process.exit(1);
}
fs.renameSync(tmpPath, targetPath);

console.log('  Strategy parameters updated: ' + targetPath);
if (failCount > 0) {
    console.error('  WARNING: ' + failCount + ' parameter(s) could not be applied');
}
