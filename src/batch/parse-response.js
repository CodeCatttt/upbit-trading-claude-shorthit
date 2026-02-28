/**
 * parse-response.js
 * Parses Claude CLI stdout to extract decision JSON and strategy code.
 * Validates JSON schema, code syntax, and strategy interface compliance.
 * Multi-asset interface: SWITCH/HOLD/NONE with candlesByMarket.
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

function extractCustomIndicatorsBlock(text) {
    const matches = [...text.matchAll(/```custom-indicators\s*\n([\s\S]*?)\n\s*```/g)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1].trim();
}

function validateCustomIndicators(code) {
    const errors = [];
    if (!code) return errors;

    const tmpFile = path.join(__dirname, '../strategies/.tmp-custom-indicators-check.js');
    try {
        fs.writeFileSync(tmpFile, code);
        execSync(`node -c "${tmpFile}"`, { stdio: 'pipe' });
    } catch (e) {
        errors.push(`Custom indicators syntax error: ${e.stderr?.toString().trim() || e.message}`);
        try { fs.unlinkSync(tmpFile); } catch {}
        return errors;
    }

    try {
        delete require.cache[require.resolve(tmpFile)];
        const mod = require(tmpFile);
        if (typeof mod !== 'object' || mod === null) {
            errors.push('Custom indicators must export an object');
        }
    } catch (e) {
        errors.push(`Custom indicators runtime error: ${e.message}`);
    }

    try { fs.unlinkSync(tmpFile); } catch {}
    return errors;
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
    // Validate optional string fields
    if (decision.notes !== undefined && typeof decision.notes !== 'string') {
        errors.push('notes must be a string');
    }
    if (decision.strategicNotes !== undefined && typeof decision.strategicNotes !== 'string') {
        errors.push('strategicNotes must be a string');
    }
    // Validate markets field if present
    if (decision.markets !== undefined) {
        if (!Array.isArray(decision.markets)) {
            errors.push('markets must be an array');
        } else if (decision.markets.length === 0) {
            errors.push('markets array must not be empty');
        } else {
            for (const m of decision.markets) {
                if (typeof m !== 'string' || !m.startsWith('KRW-')) {
                    errors.push(`Invalid market format: ${m} (must be KRW-XXX)`);
                    break;
                }
            }
        }
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

        // 3. Mock call test with multi-asset interface
        if (typeof mod.createStrategyState === 'function' && typeof mod.onNewCandle === 'function') {
            const state = mod.createStrategyState();
            if (!state || !state.assetHeld) {
                errors.push('createStrategyState must return { assetHeld: ... }');
            }

            // Create minimal mock candles for multi-timeframe interface
            const mockCandles15 = Array.from({ length: 100 }, (_, i) => ({
                open: 100000 + i * 10,
                high: 100010 + i * 10,
                low: 99990 + i * 10,
                close: 100000 + i * 10,
                volume: 1,
                timestamp: `2025-01-01T${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00`,
            }));

            const mockCandles240 = Array.from({ length: 10 }, (_, i) => ({
                open: 100000 + i * 100,
                high: 100100 + i * 100,
                low: 99900 + i * 100,
                close: 100000 + i * 100,
                volume: 10,
                timestamp: `2025-01-01T${String(i * 4).padStart(2, '0')}:00:00`,
            }));

            // Test with nested candleData object (multi-timeframe interface)
            const mockCandleData = {
                'KRW-BTC': { 15: mockCandles15, 240: mockCandles240 },
                'KRW-ETH': {
                    15: mockCandles15.map(c => ({ ...c, close: c.close / 20 })),
                    240: mockCandles240.map(c => ({ ...c, close: c.close / 20 })),
                },
            };

            const result = mod.onNewCandle(state, mockCandleData);
            if (!result || !result.action) {
                errors.push('onNewCandle did not return { action, details }');
            } else if (!['SWITCH', 'HOLD', 'NONE'].includes(result.action)) {
                errors.push(`Invalid action from onNewCandle: ${result.action} (expected SWITCH, HOLD, or NONE)`);
            } else if (result.action === 'SWITCH') {
                if (!result.details || !result.details.targetMarket) {
                    errors.push('SWITCH action must include details.targetMarket');
                }
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
    let customIndicatorsCode = null;
    let customIndicatorsErrors = [];

    if (decision && decision.action === 'replace') {
        strategyCode = extractLastJsBlock(text);
        codeErrors = validateStrategyCode(strategyCode);

        customIndicatorsCode = extractCustomIndicatorsBlock(text);
        if (customIndicatorsCode) {
            customIndicatorsErrors = validateCustomIndicators(customIndicatorsCode);
        }
    }

    const allErrors = [...decisionErrors, ...codeErrors, ...customIndicatorsErrors];
    const result = {
        valid: allErrors.length === 0,
        decision,
        strategyCode,
        customIndicatorsCode,
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

module.exports = { parseResponse, extractLastJsonBlock, extractLastJsBlock, extractCustomIndicatorsBlock };
