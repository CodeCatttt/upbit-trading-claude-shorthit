/**
 * Tests for CandleManager — real-time candle aggregation from trade data.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CandleManager } = require('../src/core/candle-manager');

// Helper: generate a timestamp for a specific minute
function ts(year, month, day, hour, minute, second = 0) {
    return new Date(year, month - 1, day, hour, minute, second).getTime();
}

describe('CandleManager', () => {
    describe('constructor', () => {
        it('should initialize empty candle buffers for each market', () => {
            const cm = new CandleManager(['KRW-BTC', 'KRW-ETH']);
            assert.deepStrictEqual(cm.getCandles('KRW-BTC', 1, false), []);
            assert.deepStrictEqual(cm.getCandles('KRW-ETH', 5, false), []);
        });
    });

    describe('processTrade', () => {
        it('should build a 1m candle from trades within the same minute', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const baseTs = ts(2026, 3, 29, 10, 0, 0);

            cm.processTrade('KRW-BTC', 100000, 0.1, baseTs);
            cm.processTrade('KRW-BTC', 100500, 0.2, baseTs + 10000);
            cm.processTrade('KRW-BTC', 99500, 0.15, baseTs + 20000);
            cm.processTrade('KRW-BTC', 100200, 0.05, baseTs + 50000);

            // Should have 0 completed + 1 building candle
            const candles = cm.getCandles('KRW-BTC', 1, true);
            assert.equal(candles.length, 1);

            const c = candles[0];
            assert.equal(c.open, 100000);
            assert.equal(c.high, 100500);
            assert.equal(c.low, 99500);
            assert.equal(c.close, 100200);
            assert.ok(Math.abs(c.volume - 0.5) < 1e-10, `Volume should be ~0.5, got ${c.volume}`); // 0.1+0.2+0.15+0.05
        });

        it('should close 1m candle when trades move to next minute', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const minute0 = ts(2026, 3, 29, 10, 0, 0);
            const minute1 = ts(2026, 3, 29, 10, 1, 0);

            // Trades in minute 0
            cm.processTrade('KRW-BTC', 100000, 0.1, minute0);
            cm.processTrade('KRW-BTC', 100500, 0.2, minute0 + 30000);

            // Trade in minute 1 — should close minute 0 candle
            const result = cm.processTrade('KRW-BTC', 101000, 0.1, minute1);

            assert.ok(result.closed1m, 'Should have closed a 1m candle');
            assert.equal(result.closed1m.open, 100000);
            assert.equal(result.closed1m.close, 100500);

            // Completed candles (excluding building)
            const completed = cm.getCandles('KRW-BTC', 1, false);
            assert.equal(completed.length, 1);

            // Including building
            const all = cm.getCandles('KRW-BTC', 1, true);
            assert.equal(all.length, 2);
            assert.equal(all[1].open, 101000); // new building candle
        });

        it('should close 5m candle when crossing 5-minute boundary', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const min0 = ts(2026, 3, 29, 10, 0, 0);
            const min3 = ts(2026, 3, 29, 10, 3, 0);
            const min5 = ts(2026, 3, 29, 10, 5, 0);

            cm.processTrade('KRW-BTC', 100000, 0.1, min0);
            cm.processTrade('KRW-BTC', 100500, 0.2, min3);

            const result = cm.processTrade('KRW-BTC', 101000, 0.1, min5);

            assert.ok(result.closed5m, 'Should have closed a 5m candle');
            assert.equal(result.closed5m.open, 100000);
            assert.equal(result.closed5m.high, 100500);
            assert.equal(result.closed5m.close, 100500);
        });

        it('should handle multiple candle closings across many minutes', () => {
            const cm = new CandleManager(['KRW-BTC']);
            let closedCount = 0;

            for (let min = 0; min < 10; min++) {
                const t = ts(2026, 3, 29, 10, min, 0);
                const result = cm.processTrade('KRW-BTC', 100000 + min * 100, 0.1, t);
                if (result.closed1m) closedCount++;
            }

            // First trade creates building, subsequent 9 close previous
            assert.equal(closedCount, 9);
            assert.equal(cm.getCandles('KRW-BTC', 1, false).length, 9);
        });

        it('should not process trades for unknown markets', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const result = cm.processTrade('KRW-UNKNOWN', 100, 1, Date.now());
            assert.deepStrictEqual(result, { closed1m: null, closed5m: null });
        });

        it('should respect buffer limits', () => {
            const cm = new CandleManager(['KRW-BTC'], { buffer1m: 5 });

            for (let min = 0; min < 10; min++) {
                const t = ts(2026, 3, 29, 10, min, 0);
                cm.processTrade('KRW-BTC', 100000, 0.1, t);
            }

            // Buffer is 5, so completed should be capped
            const completed = cm.getCandles('KRW-BTC', 1, false);
            assert.ok(completed.length <= 5, `Expected <= 5, got ${completed.length}`);
        });
    });

    describe('seedCandles', () => {
        it('should pre-populate candle data', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const seed = [
                { open: 100, high: 105, low: 95, close: 102, volume: 1, timestamp: '2026-03-29T10:00:00' },
                { open: 102, high: 108, low: 100, close: 107, volume: 2, timestamp: '2026-03-29T10:01:00' },
            ];

            cm.seedCandles('KRW-BTC', 1, seed);

            const candles = cm.getCandles('KRW-BTC', 1, false);
            assert.equal(candles.length, 2);
            assert.equal(candles[0].open, 100);
        });
    });

    describe('getLatestPrice', () => {
        it('should return latest price from building candle', () => {
            const cm = new CandleManager(['KRW-BTC']);
            const t = ts(2026, 3, 29, 10, 0, 0);

            cm.processTrade('KRW-BTC', 100000, 0.1, t);
            cm.processTrade('KRW-BTC', 100500, 0.1, t + 10000);

            assert.equal(cm.getLatestPrice('KRW-BTC'), 100500);
        });

        it('should return null for market with no data', () => {
            const cm = new CandleManager(['KRW-BTC']);
            assert.equal(cm.getLatestPrice('KRW-BTC'), null);
        });
    });
});
