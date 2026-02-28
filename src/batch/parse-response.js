/**
 * parse-response.js
 * Parses Claude CLI stdout to extract decision JSON and strategy code.
 * Validates JSON schema, code syntax, and strategy interface compliance.
 *
 * Usage: echo "$CLAUDE_OUTPUT" | node parse-response.js
 * Outputs validated JSON to stdout with { decision, strategyCode?, valid, errors }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('../utils/logger');

const log = createLogger('PARSE-RESPONSE');

function extractLastJsonBlock(text) {
    const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)];
    if (matches.length === 0) return null;
    const raw = matches[matches.length - 1][1].trim();
    try {
        return JSON.parse(raw);
    } catch (e) {
        log.error('JSON parse error:', e.message);
        return null;
    }
}

function extractLastJsBlock(text) {
    const matches = [...text.matchAll(/```javascript\s*\n([\s\S]*?)\n\s*```/g)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1].trim();
}

function validateDecision(decision) {
    const errors = [];
    if (!decision) {
        errors.push('No decision JSON found');
        return errors;
    }
    if (!['keep', 'modify', 'replace'].includes(decision.action)) {
        errors.push(`Invalid action: ${decision.action}`);
    }
    if (typeof decision.reasoning !== 'string' || decision.reasoning.length === 0) {
        errors.push('Missing reasoning');
    }
    if (typeof decision.confidence !== 'number' || decision.confidence < 0 || decision.confidence > 1) {
        errors.push(`Invalid confidence: ${decision.confidence}`);
    }
    return errors;
}

function validateStrategyCode(code) {
    const errors = [];
    if (!code) {
        errors.push('No strategy code found');
        return errors;
    }

    // 1. Syntax check via node -c
    const tmpFile = path.join(__dirname, '../strategies/.tmp-strategy-check.js');
    try {
        fs.writeFileSync(tmpFile, code);
        execSync(`node -c "${tmpFile}"`, { stdio: 'pipe' });
    } catch (e) {
        errors.push(`Syntax error: ${e.stderr?.toString().trim() || e.message}`);
        try { fs.unlinkSync(tmpFile); } catch {}
        return errors;
    }

    // 2. Require and check exports
    try {
        // Clear cache
        delete require.cache[require.resolve(tmpFile)];
        const mod = require(tmpFile);

        if (!mod.DEFAULT_CONFIG || typeof mod.DEFAULT_CONFIG !== 'object') {
            errors.push('Missing or invalid DEFAULT_CONFIG export');
        }
        if (typeof mod.createStrategyState !== 'function') {
            errors.push('Missing createStrategyState function');
        }
        if (typeof mod.onNewCandle !== 'function') {
            errors.push('Missing onNewCandle function');
        }

        // 3. Mock call test
        if (typeof mod.createStrategyState === 'function' && typeof mod.onNewCandle === 'function') {
            const state = mod.createStrategyState();
            if (!state || !state.assetHeld) {
                errors.push('createStrategyState must return { assetHeld: ... }');
            }

            // Create minimal mock candles
            const mockCandles = Array.from({ length: 100 }, (_, i) => ({
                open: 100000 + i * 10,
                high: 100010 + i * 10,
                low: 99990 + i * 10,
                close: 100000 + i * 10,
                volume: 1,
                timestamp: `2025-01-01T${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00`,
            }));

            const result = mod.onNewCandle(state, mockCandles, mockCandles);
            if (!result || !result.action) {
                errors.push('onNewCandle did not return { action, details }');
            } else if (!['SWITCH_TO_BTC', 'SWITCH_TO_ETH', 'HOLD', 'NONE'].includes(result.action)) {
                errors.push(`Invalid action from onNewCandle: ${result.action}`);
            }
        }
    } catch (e) {
        errors.push(`Runtime error: ${e.message}`);
    }

    try { fs.unlinkSync(tmpFile); } catch {}
    return errors;
}

function parseResponse(text) {
    const decision = extractLastJsonBlock(text);
    const decisionErrors = validateDecision(decision);

    let strategyCode = null;
    let codeErrors = [];

    if (decision && decision.action === 'replace') {
        strategyCode = extractLastJsBlock(text);
        codeErrors = validateStrategyCode(strategyCode);
    }

    const allErrors = [...decisionErrors, ...codeErrors];
    const result = {
        valid: allErrors.length === 0,
        decision,
        strategyCode,
        errors: allErrors,
    };

    return result;
}

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        const result = parseResponse(input);
        console.log(JSON.stringify(result, null, 2));
        if (!result.valid) {
            log.error('Validation failed:', result.errors);
            process.exit(1);
        }
    });
}

module.exports = { parseResponse, extractLastJsonBlock, extractLastJsBlock };
