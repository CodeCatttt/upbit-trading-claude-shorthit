/**
 * Tests for RiskManager — day trading risk controls.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { RiskManager } = require('../src/core/risk-manager');

describe('RiskManager', () => {
    let rm;

    beforeEach(() => {
        rm = new RiskManager({
            maxDailyLossPct: 3,
            maxDailyTrades: 100,
            stopLossPct: 0.3,
            takeProfitPct: 0.5,
            pauseDurationMs: 5000,
            pauseThresholdPct: 1.0,
            pauseWindowMs: 60000,
        });
        rm.setDailyStartBalance(1000000);
    });

    describe('canTrade', () => {
        it('should allow trading when no limits reached', () => {
            const result = rm.canTrade();
            assert.equal(result.allowed, true);
        });

        it('should block trading when daily trade limit reached', () => {
            rm.dailyTradeCount = 100;
            const result = rm.canTrade();
            assert.equal(result.allowed, false);
            assert.ok(result.reason.includes('daily trade limit'));
        });

        it('should block trading when daily loss limit reached', () => {
            rm.dailyPnL = -30000; // -3% of 1M
            const result = rm.canTrade();
            assert.equal(result.allowed, false);
            assert.ok(result.reason.includes('daily loss limit'));
        });

        it('should block trading during pause', () => {
            rm.pausedUntil = Date.now() + 10000;
            const result = rm.canTrade();
            assert.equal(result.allowed, false);
            assert.ok(result.reason.includes('paused'));
        });
    });

    describe('checkPositionExit', () => {
        it('should trigger stop loss', () => {
            rm.enterPosition('KRW-BTC', 100000, 1);
            const result = rm.checkPositionExit(99650); // -0.35%
            assert.equal(result.shouldExit, true);
            assert.equal(result.reason, 'stop_loss');
        });

        it('should trigger take profit', () => {
            rm.enterPosition('KRW-BTC', 100000, 1);
            const result = rm.checkPositionExit(100550); // +0.55%
            assert.equal(result.shouldExit, true);
            assert.equal(result.reason, 'take_profit');
        });

        it('should hold when within range', () => {
            rm.enterPosition('KRW-BTC', 100000, 1);
            const result = rm.checkPositionExit(100100); // +0.1%
            assert.equal(result.shouldExit, false);
            assert.equal(result.reason, 'holding');
        });

        it('should report no_position when not in position', () => {
            const result = rm.checkPositionExit(100000);
            assert.equal(result.shouldExit, false);
            assert.equal(result.reason, 'no_position');
        });
    });

    describe('recordTrade', () => {
        it('should increment daily trade count', () => {
            rm.recordTrade(0.2, 2000);
            assert.equal(rm.dailyTradeCount, 1);
            assert.equal(rm.dailyPnL, 2000);
        });

        it('should trigger pause when rolling window loss exceeds threshold', () => {
            // Record several losing trades
            rm.recordTrade(-0.4, -4000);
            rm.recordTrade(-0.3, -3000);
            rm.recordTrade(-0.4, -4000);
            // Total rolling loss: 1.1% > threshold of 1.0%

            assert.ok(rm.pausedUntil > Date.now());
            const check = rm.canTrade();
            assert.equal(check.allowed, false);
        });

        it('should clear position after recording trade', () => {
            rm.enterPosition('KRW-BTC', 100000, 1);
            assert.ok(rm.position !== null);
            rm.recordTrade(0.2, 2000);
            assert.equal(rm.position, null);
        });
    });

    describe('getStatus', () => {
        it('should return complete status summary', () => {
            rm.enterPosition('KRW-BTC', 100000, 1);
            rm.recordTrade(0.3, 3000);
            rm.recordTrade(-0.1, -1000);

            const status = rm.getStatus();
            assert.equal(status.dailyTradeCount, 2);
            assert.equal(status.dailyPnL, 2000);
            assert.equal(status.recentWins, 1);
            assert.equal(status.recentLosses, 1);
            assert.equal(status.winRate, 50);
            assert.equal(status.hasPosition, false);
        });
    });

    describe('daily reset', () => {
        it('should reset counters on new day', () => {
            rm.dailyTradeCount = 50;
            rm.dailyPnL = 10000;
            rm.dailyDate = '2020-01-01'; // Force old date

            const result = rm.canTrade(); // triggers day check
            assert.equal(result.allowed, true);
            assert.equal(rm.dailyTradeCount, 0);
            assert.equal(rm.dailyPnL, 0);
        });
    });
});
