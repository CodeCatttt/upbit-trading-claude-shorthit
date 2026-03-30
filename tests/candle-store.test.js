/**
 * Tests for candle-store — persistent 7-day rolling candle storage.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { appendCandles, loadCandles, getStoreStats, cleanup, STORE_DIR } = require('../src/core/candle-store');

const TEST_MARKET = 'KRW-TEST';

function testFilePath(interval) {
    return path.join(STORE_DIR, `${TEST_MARKET}_${interval}m_history.json`);
}

function makeCandle(minutesAgo) {
    const d = new Date(Date.now() - minutesAgo * 60000);
    return {
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1,
        timestamp: d.toISOString().slice(0, 19),
    };
}

describe('CandleStore', () => {
    afterEach(() => {
        // Clean up test files
        try { fs.unlinkSync(testFilePath(1)); } catch {}
        try { fs.unlinkSync(testFilePath(5)); } catch {}
    });

    describe('appendCandles', () => {
        it('should create file and store candles', () => {
            const candles = [makeCandle(3), makeCandle(2), makeCandle(1)];
            appendCandles(TEST_MARKET, 1, candles);

            const stored = loadCandles(TEST_MARKET, 1);
            assert.equal(stored.length, 3);
        });

        it('should append without duplicating', () => {
            const candles1 = [makeCandle(3), makeCandle(2)];
            const candles2 = [makeCandle(2), makeCandle(1)]; // overlap on minutesAgo=2

            appendCandles(TEST_MARKET, 1, candles1);
            appendCandles(TEST_MARKET, 1, candles2);

            const stored = loadCandles(TEST_MARKET, 1);
            assert.equal(stored.length, 3); // not 4
        });

        it('should sort chronologically', () => {
            const candles = [makeCandle(1), makeCandle(3), makeCandle(2)]; // unsorted
            appendCandles(TEST_MARKET, 1, candles);

            const stored = loadCandles(TEST_MARKET, 1);
            for (let i = 1; i < stored.length; i++) {
                assert.ok(stored[i].timestamp >= stored[i - 1].timestamp,
                    'Should be sorted chronologically');
            }
        });

        it('should trim candles older than 7 days', () => {
            const oldCandle = {
                open: 100, high: 105, low: 95, close: 102, volume: 1,
                timestamp: '2020-01-01T00:00:00', // very old
            };
            const newCandle = makeCandle(1);

            appendCandles(TEST_MARKET, 1, [oldCandle, newCandle]);

            const stored = loadCandles(TEST_MARKET, 1);
            assert.equal(stored.length, 1); // old one trimmed
            assert.ok(stored[0].timestamp !== '2020-01-01T00:00:00');
        });

        it('should handle empty array gracefully', () => {
            appendCandles(TEST_MARKET, 1, []);
            const stored = loadCandles(TEST_MARKET, 1);
            assert.equal(stored.length, 0);
        });
    });

    describe('loadCandles', () => {
        it('should return empty array for nonexistent market', () => {
            const result = loadCandles('KRW-NONEXISTENT', 1);
            assert.deepStrictEqual(result, []);
        });
    });

    describe('getStoreStats', () => {
        it('should report stats for stored data', () => {
            appendCandles(TEST_MARKET, 1, [makeCandle(3), makeCandle(2), makeCandle(1)]);
            appendCandles(TEST_MARKET, 5, [makeCandle(10), makeCandle(5)]);

            const stats = getStoreStats();
            assert.ok(stats[TEST_MARKET]);
            assert.equal(stats[TEST_MARKET]['1'].count, 3);
            assert.equal(stats[TEST_MARKET]['5'].count, 2);
        });
    });

    describe('cleanup', () => {
        it('should remove old candles across all files', () => {
            const old = {
                open: 100, high: 105, low: 95, close: 102, volume: 1,
                timestamp: '2020-01-01T00:00:00',
            };
            const recent = makeCandle(1);

            // Write directly to test
            if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
            fs.writeFileSync(testFilePath(1), JSON.stringify([old, recent]));

            const trimmed = cleanup();
            assert.ok(trimmed >= 1);

            const stored = loadCandles(TEST_MARKET, 1);
            assert.equal(stored.length, 1);
        });
    });
});
