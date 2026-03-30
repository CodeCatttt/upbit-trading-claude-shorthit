/**
 * Tests for dynamic market selector.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

describe('MarketSelector', () => {
    describe('selectTopMarkets (live API)', () => {
        it('should fetch and rank KRW markets by volume', async () => {
            const { selectTopMarkets } = require('../src/core/market-selector');
            const markets = await selectTopMarkets(5, 0); // No min volume for test

            assert.ok(Array.isArray(markets));
            assert.ok(markets.length > 0, 'Should find at least 1 KRW market');
            assert.ok(markets.length <= 5, `Should return at most 5, got ${markets.length}`);

            // All should be KRW- prefixed
            for (const m of markets) {
                assert.ok(m.startsWith('KRW-'), `${m} should start with KRW-`);
            }

            // BTC should typically be #1 by volume
            assert.ok(markets.includes('KRW-BTC'), 'KRW-BTC should be in top 5 by volume');
        });

        it('should exclude USDT/USDC stablecoins', async () => {
            const { selectTopMarkets } = require('../src/core/market-selector');
            const markets = await selectTopMarkets(50, 0);

            assert.ok(!markets.includes('KRW-USDT'), 'Should exclude USDT');
            assert.ok(!markets.includes('KRW-USDC'), 'Should exclude USDC');
        });

        it('should respect topN limit', async () => {
            const { selectTopMarkets } = require('../src/core/market-selector');
            const markets = await selectTopMarkets(3, 0);

            assert.ok(markets.length <= 3);
        });

        it('should filter by minimum volume', async () => {
            const { selectTopMarkets } = require('../src/core/market-selector');
            // Very high minimum — should return fewer markets
            const markets = await selectTopMarkets(50, 1_000_000_000_000); // 1T KRW
            assert.ok(markets.length < 5, 'Very high min volume should filter most out');
        });
    });

    describe('updateConfig', () => {
        it('should write markets to trading-config.json', () => {
            const { updateConfig } = require('../src/core/market-selector');
            const configPath = path.join(__dirname, '../trading-config.json');

            // Read current config to restore later
            const originalConfig = fs.readFileSync(configPath, 'utf8');

            try {
                const result = updateConfig(['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);
                assert.deepStrictEqual(result.markets, ['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);

                // Verify file was written
                const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                assert.deepStrictEqual(saved.markets, ['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);
                assert.equal(saved.updatedBy, 'market-selector');
            } finally {
                // Restore original config
                fs.writeFileSync(configPath, originalConfig);
            }
        });

        it('should track added/removed markets', () => {
            const { updateConfig } = require('../src/core/market-selector');
            const configPath = path.join(__dirname, '../trading-config.json');
            const originalConfig = fs.readFileSync(configPath, 'utf8');

            try {
                // First set baseline
                updateConfig(['KRW-BTC', 'KRW-ETH']);
                // Now change
                const result = updateConfig(['KRW-BTC', 'KRW-SOL', 'KRW-XRP']);

                assert.ok(result.added.includes('KRW-SOL'));
                assert.ok(result.added.includes('KRW-XRP'));
                assert.ok(result.removed.includes('KRW-ETH'));
            } finally {
                fs.writeFileSync(configPath, originalConfig);
            }
        });
    });

    describe('refreshMarkets (live API)', () => {
        it('should select markets and update config', async () => {
            const { refreshMarkets } = require('../src/core/market-selector');
            const configPath = path.join(__dirname, '../trading-config.json');
            const originalConfig = fs.readFileSync(configPath, 'utf8');

            try {
                const result = await refreshMarkets(8);
                assert.ok(result, 'Should return result');
                assert.ok(result.markets.length > 0, 'Should have markets');
                assert.ok(result.markets.length <= 8);
                assert.ok(result.markets.includes('KRW-BTC'));

                // Verify config was updated
                const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                assert.deepStrictEqual(saved.markets, result.markets);
            } finally {
                fs.writeFileSync(configPath, originalConfig);
            }
        });
    });
});
