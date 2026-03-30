/**
 * Tests for batch system integration with day-trading architecture.
 * Verifies that batch components correctly reference scalping strategy files.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

describe('Batch Integration', () => {
    describe('file references', () => {
        it('deploy.js should reference scalping-strategy.js', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/eval/deploy.js'), 'utf8');
            assert.ok(content.includes('scalping-strategy.js'), 'deploy.js should reference scalping-strategy.js');
            assert.ok(content.includes('upbit-day-trading-bot'), 'deploy.js should reference upbit-day-trading-bot PM2 name');
        });

        it('deploy.js should support scalping interface in dry-run', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/eval/deploy.js'), 'utf8');
            assert.ok(content.includes('isScalping'), 'deploy.js should detect scalping strategy type');
            assert.ok(content.includes('mod.analyze'), 'deploy.js should call analyze() for scalping');
        });

        it('collect-metrics.js should reference scalping-strategy.js', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/eval/collect-metrics.js'), 'utf8');
            assert.ok(content.includes('scalping-strategy.js'), 'collect-metrics should read scalping strategy');
        });

        it('backtest.js should have day-trading gate thresholds', () => {
            const { GATE_THRESHOLDS } = require('../src/batch/eval/backtest');
            assert.ok(GATE_THRESHOLDS.replace.maxDailyTrades >= 100,
                `replace maxDailyTrades should be >= 100 for day trading, got ${GATE_THRESHOLDS.replace.maxDailyTrades}`);
            assert.ok(GATE_THRESHOLDS.replace.minDailyTrades >= 1,
                `replace minDailyTrades should be >= 1 for day trading, got ${GATE_THRESHOLDS.replace.minDailyTrades}`);
        });

        it('run-batch.sh should reference scalping-strategy.js', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/pipeline/run-batch.sh'), 'utf8');
            assert.ok(content.includes('scalping-strategy.js'), 'run-batch.sh should reference scalping strategy');
            assert.ok(content.includes('upbit-day-trading-bot'), 'run-batch.sh should reference day trading PM2 name');
            assert.ok(!content.includes('current-strategy.js'), 'run-batch.sh should NOT reference current-strategy.js');
        });
    });

    describe('batch-scheduler triggers', () => {
        it('should have day-trading appropriate check interval', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/pipeline/batch-scheduler.js'), 'utf8');
            // Check interval should be 5 minutes for day trading
            assert.ok(content.includes('5 * 60 * 1000'), 'Check interval should be 5 minutes');
        });

        it('should have POOR_WIN_RATE trigger', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/pipeline/batch-scheduler.js'), 'utf8');
            assert.ok(content.includes('POOR_WIN_RATE'), 'Should have POOR_WIN_RATE trigger');
            assert.ok(content.includes('checkPoorWinRate'), 'Should have checkPoorWinRate function');
        });

        it('should use hours for stagnation instead of days', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/pipeline/batch-scheduler.js'), 'utf8');
            assert.ok(content.includes('STAGNATION_HOURS'), 'Should use hours-based stagnation');
            assert.ok(content.includes('hoursSinceTrade'), 'Should measure hours since trade');
        });

        it('should have shorter strategy tier intervals', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/pipeline/batch-scheduler.js'), 'utf8');
            assert.ok(content.includes('2 * 60 * 60 * 1000'), 'Strategy interval should be 2 hours');
            assert.ok(content.includes('1 * 60 * 60 * 1000'), 'Urgent interval should be 1 hour');
        });
    });

    describe('build-prompt constraints', () => {
        it('should describe scalping strategy interface', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/prompt/build-prompt.js'), 'utf8');
            assert.ok(content.includes("'BUY'|'SELL'|'HOLD'"), 'Should describe BUY/SELL/HOLD actions');
            assert.ok(content.includes('analyze(candles1m'), 'Should describe analyze function');
            assert.ok(content.includes('0.3% stop-loss'), 'Should mention stop-loss');
        });

        it('should describe day trading context in header', () => {
            const content = fs.readFileSync(path.join(PROJECT_ROOT, 'src/batch/prompt/build-prompt.js'), 'utf8');
            assert.ok(content.includes('high-frequency day trading'), 'Header should mention day trading');
            assert.ok(content.includes('1000 trades/day'), 'Should mention trade target');
        });
    });

    describe('ecosystem config', () => {
        it('should point to day-trading-bot.js', () => {
            const config = require('../ecosystem.config.js');
            const bot = config.apps.find(a => a.name === 'upbit-day-trading-bot');
            assert.ok(bot, 'Should have upbit-day-trading-bot app');
            assert.ok(bot.script.includes('day-trading-bot.js'), 'Should run day-trading-bot.js');
        });
    });

    describe('trading-config.json', () => {
        it('should have 1m and 5m candle intervals', () => {
            const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'trading-config.json'), 'utf8'));
            assert.ok(config.candleIntervals.includes(1), 'Should include 1m interval');
            assert.ok(config.candleIntervals.includes(5), 'Should include 5m interval');
        });

        it('should have risk config', () => {
            const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'trading-config.json'), 'utf8'));
            assert.ok(config.risk, 'Should have risk section');
            assert.equal(config.risk.maxDailyTrades, 1000);
            assert.equal(config.risk.stopLossPct, 0.3);
            assert.equal(config.risk.takeProfitPct, 0.5);
        });
    });
});
