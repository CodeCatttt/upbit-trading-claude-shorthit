/**
 * backtest.js
 * Multi-asset backtest engine with slippage model.
 * Simulates strategy over historical candle data.
 * Calculates return, max drawdown, trade frequency, per-market benchmarks.
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
const FEE_RATE = 0.0005;    // 0.05% per trade (Upbit)
const SLIPPAGE_RATE = 0.001; // 0.1% slippage (market order assumption)
const RESULTS_DIR = path.join(__dirname, '../../data/backtest-results');
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return { markets: ['KRW-BTC', 'KRW-ETH'], candleIntervals: [15, 240] };
    }
}

function runBacktest(strategy, candlesByMarket, label = 'unnamed') {
    const markets = Object.keys(candlesByMarket);
    if (markets.length < 2) {
        return { error: 'Need at least 2 markets for backtest' };
    }

    // Find shortest candle length across markets
    const minLength = Math.min(...markets.map(m => candlesByMarket[m].length));
    if (minLength < 100) {
        return { error: 'Insufficient candle data for backtest' };
    }

    const state = strategy.createStrategyState();
    const startAsset = state.assetHeld;

    // Record start prices for benchmarks
    const startPrices = {};
    for (const market of markets) {
        startPrices[market] = candlesByMarket[market][0].close;
    }

    // Start with 1,000,000 KRW worth of default asset
    let portfolio = 1000000;
    let holdings = portfolio / startPrices[startAsset]; // units of start asset
    let currentAsset = startAsset;
    let trades = [];
    let equityCurve = [];
    let peak = portfolio;
    let maxDrawdown = 0;

    const lookback = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.lookback) || 60;
    const startIdx = Math.max(lookback, 60);

    for (let i = startIdx; i < minLength; i++) {
        // Build candlesByMarket slice up to index i
        const slicedCandles = {};
        for (const market of markets) {
            slicedCandles[market] = candlesByMarket[market].slice(0, i + 1);
        }

        const result = strategy.onNewCandle(state, slicedCandles);

        // Calculate current portfolio value
        const currentPrice = candlesByMarket[currentAsset][i].close;
        const currentValue = holdings * currentPrice;

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            const target = result.details.targetMarket;
            if (target !== currentAsset && candlesByMarket[target]) {
                const sellPrice = candlesByMarket[currentAsset][i].close;
                const buyPrice = candlesByMarket[target][i].close;

                // Sell: price * (1 - slippage), then fee
                const krwAfterSell = holdings * sellPrice * (1 - SLIPPAGE_RATE) * (1 - FEE_RATE);
                // Buy: price * (1 + slippage), then fee
                const effectiveBuyPrice = buyPrice * (1 + SLIPPAGE_RATE);
                holdings = (krwAfterSell * (1 - FEE_RATE)) / effectiveBuyPrice;

                trades.push({
                    idx: i,
                    timestamp: candlesByMarket[currentAsset][i].timestamp,
                    action: 'SWITCH',
                    from: currentAsset,
                    to: target,
                    sellPrice,
                    buyPrice,
                });

                currentAsset = target;
            }
        }

        const value = holdings * candlesByMarket[currentAsset][i].close;
        equityCurve.push(value);

        if (value > peak) peak = value;
        const dd = (peak - value) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const finalIdx = minLength - 1;
    const finalPrice = candlesByMarket[currentAsset][finalIdx].close;
    const finalValue = holdings * finalPrice;
    const returnPct = ((finalValue - portfolio) / portfolio) * 100;

    // Per-market benchmarks: buy and hold
    const benchmarks = {};
    for (const market of markets) {
        const startP = startPrices[market];
        const endP = candlesByMarket[market][finalIdx].close;
        benchmarks[market] = +((endP - startP) / startP * 100).toFixed(4);
    }

    // Estimate daily trades (assuming 15m candles, 96 per day)
    const totalPeriods = minLength - startIdx;
    const days = totalPeriods / 96;
    const dailyTrades = days > 0 ? trades.length / days : 0;

    return {
        label,
        returnPct: parseFloat(returnPct.toFixed(4)),
        maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(4)),
        totalTrades: trades.length,
        dailyTrades: parseFloat(dailyTrades.toFixed(2)),
        benchmarks,
        finalValue: Math.floor(finalValue),
        periodCandles: totalPeriods,
        slippageRate: SLIPPAGE_RATE,
        feeRate: FEE_RATE,
        trades: trades.slice(-20), // Last 20 trades for review
    };
}

function compareStrategies(currentResult, newResult) {
    const returnImprovement = newResult.returnPct - currentResult.returnPct;
    const drawdownWorsening = newResult.maxDrawdown - currentResult.maxDrawdown;

    const pass =
        returnImprovement >= 0.5 &&    // At least 0.5% better return
        drawdownWorsening <= 2.0 &&    // Max drawdown doesn't worsen by >2%
        newResult.dailyTrades <= 6;    // No more than 6 trades per day

    return {
        pass,
        returnImprovement: parseFloat(returnImprovement.toFixed(4)),
        drawdownWorsening: parseFloat(drawdownWorsening.toFixed(4)),
        dailyTrades: newResult.dailyTrades,
        reasons: [
            pass ? 'PASSED' : 'FAILED',
            `Return improvement: ${returnImprovement.toFixed(2)}% (need >= 0.5%)`,
            `Drawdown worsening: ${drawdownWorsening.toFixed(2)}% (need <= 2.0%)`,
            `Daily trades: ${newResult.dailyTrades} (need <= 6)`,
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

    process.stderr.write(`[BACKTEST] Strategy: ${resolvedPath}\n`);

    const strategy = require(resolvedPath);
    const config = loadTradingConfig();

    // Build candlesByMarket from stored candle data
    const candlesByMarket = {};
    for (const market of config.markets) {
        const candles = store.getCandles(market, 15);
        if (candles.length > 0) {
            candlesByMarket[market] = candles;
        }
    }

    const marketsLoaded = Object.keys(candlesByMarket);
    if (marketsLoaded.length < 2) {
        process.stderr.write(`[BACKTEST] Not enough candle data. Found: ${marketsLoaded.join(', ')}. Run candle-fetcher.js first.\n`);
        process.exit(1);
    }

    process.stderr.write(`[BACKTEST] Markets: ${marketsLoaded.join(', ')}\n`);

    const result = runBacktest(strategy, candlesByMarket, path.basename(resolvedPath));
    // stdout: pure JSON only (for piping to other scripts)
    console.log(JSON.stringify(result));
    saveResult(result);
}

module.exports = { runBacktest, compareStrategies, saveResult };
