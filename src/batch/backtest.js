/**
 * backtest.js
 * Backtest engine: simulates strategy over historical candle data.
 * Calculates return, max drawdown, trade frequency, benchmark comparison.
 *
 * Usage:
 *   node backtest.js [strategyPath]
 *   If no path given, backtests current-strategy.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../data/candle-store');
const { createLogger } = require('../utils/logger');

const log = createLogger('BACKTEST');
const FEE_RATE = 0.0005; // 0.05% per trade
const RESULTS_DIR = path.join(__dirname, '../../data/backtest-results');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runBacktest(strategy, btcCandles, ethCandles, label = 'unnamed') {
    if (btcCandles.length < 100 || ethCandles.length < 100) {
        return { error: 'Insufficient candle data for backtest' };
    }

    const state = strategy.createStrategyState();
    const startPrice = { btc: btcCandles[0].close, eth: ethCandles[0].close };

    // Start with 1,000,000 KRW worth of BTC
    let portfolio = 1000000;
    let holdings = portfolio / startPrice.btc; // BTC units
    let currentAsset = 'BTC';
    let trades = [];
    let equityCurve = [];
    let peak = portfolio;
    let maxDrawdown = 0;

    const lookback = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.lookback) || 60;
    const startIdx = Math.max(lookback, 60);

    for (let i = startIdx; i < btcCandles.length; i++) {
        const btcSlice = btcCandles.slice(0, i + 1);
        const ethSlice = ethCandles.slice(0, i + 1);

        const result = strategy.onNewCandle(state, btcSlice, ethSlice);

        // Calculate current portfolio value
        const currentPrice = currentAsset === 'BTC' ? btcCandles[i].close : ethCandles[i].close;
        const currentValue = holdings * currentPrice;

        if (result.action === 'SWITCH_TO_ETH' && currentAsset === 'BTC') {
            const krwAfterSell = holdings * btcCandles[i].close * (1 - FEE_RATE);
            holdings = (krwAfterSell * (1 - FEE_RATE)) / ethCandles[i].close;
            currentAsset = 'ETH';
            trades.push({
                idx: i,
                timestamp: btcCandles[i].timestamp,
                action: 'SWITCH_TO_ETH',
                btcPrice: btcCandles[i].close,
                ethPrice: ethCandles[i].close,
            });
        } else if (result.action === 'SWITCH_TO_BTC' && currentAsset === 'ETH') {
            const krwAfterSell = holdings * ethCandles[i].close * (1 - FEE_RATE);
            holdings = (krwAfterSell * (1 - FEE_RATE)) / btcCandles[i].close;
            currentAsset = 'BTC';
            trades.push({
                idx: i,
                timestamp: btcCandles[i].timestamp,
                action: 'SWITCH_TO_BTC',
                btcPrice: btcCandles[i].close,
                ethPrice: ethCandles[i].close,
            });
        }

        const value = holdings * (currentAsset === 'BTC' ? btcCandles[i].close : ethCandles[i].close);
        equityCurve.push(value);

        if (value > peak) peak = value;
        const dd = (peak - value) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const finalIdx = btcCandles.length - 1;
    const finalPrice = currentAsset === 'BTC' ? btcCandles[finalIdx].close : ethCandles[finalIdx].close;
    const finalValue = holdings * finalPrice;
    const returnPct = ((finalValue - portfolio) / portfolio) * 100;

    // Benchmarks: buy and hold
    const btcReturn = ((btcCandles[finalIdx].close - startPrice.btc) / startPrice.btc) * 100;
    const ethReturn = ((ethCandles[finalIdx].close - startPrice.eth) / startPrice.eth) * 100;

    // Estimate daily trades (assuming 15m candles, 96 per day)
    const totalPeriods = btcCandles.length - startIdx;
    const days = totalPeriods / 96;
    const dailyTrades = days > 0 ? trades.length / days : 0;

    return {
        label,
        returnPct: parseFloat(returnPct.toFixed(4)),
        maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(4)),
        totalTrades: trades.length,
        dailyTrades: parseFloat(dailyTrades.toFixed(2)),
        btcBenchmark: parseFloat(btcReturn.toFixed(4)),
        ethBenchmark: parseFloat(ethReturn.toFixed(4)),
        finalValue: Math.floor(finalValue),
        periodCandles: totalPeriods,
        trades: trades.slice(-20), // Last 20 trades for review
    };
}

function compareStrategies(currentResult, newResult) {
    const returnImprovement = newResult.returnPct - currentResult.returnPct;
    const drawdownWorsening = newResult.maxDrawdown - currentResult.maxDrawdown;

    const pass =
        returnImprovement >= 0.5 &&    // At least 0.5% better return
        drawdownWorsening <= 2.0 &&    // Max drawdown doesn't worsen by >2%
        newResult.dailyTrades <= 4;    // No more than 4 trades per day

    return {
        pass,
        returnImprovement: parseFloat(returnImprovement.toFixed(4)),
        drawdownWorsening: parseFloat(drawdownWorsening.toFixed(4)),
        dailyTrades: newResult.dailyTrades,
        reasons: [
            pass ? 'PASSED' : 'FAILED',
            `Return improvement: ${returnImprovement.toFixed(2)}% (need >= 0.5%)`,
            `Drawdown worsening: ${drawdownWorsening.toFixed(2)}% (need <= 2.0%)`,
            `Daily trades: ${newResult.dailyTrades} (need <= 4)`,
        ],
    };
}

function saveResult(result, comparison = null) {
    ensureDir(RESULTS_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `backtest-${ts}.json`;
    const fp = path.join(RESULTS_DIR, filename);
    fs.writeFileSync(fp, JSON.stringify({ result, comparison }, null, 2));
    log.info(`Backtest result saved: ${filename}`);
    return fp;
}

// CLI entry point
if (require.main === module) {
    const strategyPath = process.argv[2] || path.join(__dirname, '../strategies/current-strategy.js');
    const resolvedPath = path.resolve(strategyPath);

    log.info(`Backtesting strategy: ${resolvedPath}`);

    const strategy = require(resolvedPath);
    const btcCandles = store.getCandles('KRW-BTC', 15);
    const ethCandles = store.getCandles('KRW-ETH', 15);

    if (btcCandles.length === 0 || ethCandles.length === 0) {
        log.error('No candle data found. Run candle-fetcher.js first.');
        process.exit(1);
    }

    const result = runBacktest(strategy, btcCandles, ethCandles, path.basename(resolvedPath));
    console.log(JSON.stringify(result, null, 2));
    saveResult(result);
}

module.exports = { runBacktest, compareStrategies, saveResult };
