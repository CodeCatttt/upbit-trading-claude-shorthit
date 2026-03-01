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

function runBacktest(strategy, candleData, label = 'unnamed') {
    // If strategy uses smart execution, model reduced slippage (50%)
    const executionMode = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.executionMode) || 'market';
    const effectiveSlippage = executionMode === 'smart' ? SLIPPAGE_RATE * 0.5 : SLIPPAGE_RATE;

    const markets = Object.keys(candleData);
    if (markets.length < 2) {
        return { error: 'Need at least 2 markets for backtest' };
    }

    // Find shortest 15m candle length across markets
    const minLength = Math.min(...markets.map(m => {
        const c15 = candleData[m][15] || candleData[m];
        return Array.isArray(c15) ? c15.length : 0;
    }));
    if (minLength < 100) {
        return { error: 'Insufficient candle data for backtest' };
    }

    // Determine if data is nested (multi-timeframe) or flat (legacy)
    const isNested = !Array.isArray(candleData[markets[0]]);

    const state = strategy.createStrategyState();
    const startAsset = state.assetHeld;

    // Helper to get 15m candles
    const get15m = (market) => isNested ? (candleData[market][15] || []) : (candleData[market] || []);
    const get240m = (market) => isNested ? (candleData[market][240] || []) : [];

    // Record start prices for benchmarks
    const startPrices = {};
    for (const market of markets) {
        startPrices[market] = get15m(market)[0].close;
    }

    // Start with 1,000,000 KRW worth of default asset
    let portfolio = 1000000;
    let holdings = portfolio / startPrices[startAsset];
    let currentAsset = startAsset;
    let trades = [];
    let equityCurve = [];
    let peak = portfolio;
    let maxDrawdown = 0;

    const lookback = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.lookback) || 60;
    const startIdx = Math.max(lookback, 60);

    // Pre-compute 240m timestamps (avoid repeated Date parsing in loop)
    const timestamps240 = {};
    for (const market of markets) {
        timestamps240[market] = get240m(market).map(c => new Date(c.timestamp).getTime());
    }

    // Pre-build slicedData with candles up to startIdx (O(n) total, not per step)
    const slicedData = {};
    const idx240 = {};
    const startTs = new Date(get15m(markets[0])[startIdx].timestamp).getTime();

    for (const market of markets) {
        const candles15 = get15m(market);
        slicedData[market] = {
            15: candles15.slice(0, startIdx + 1),
            240: [],
        };

        // Find initial 240m boundary using pre-computed timestamps
        const ts240 = timestamps240[market];
        let j = 0;
        while (j < ts240.length && ts240[j] <= startTs) {
            slicedData[market][240].push(get240m(market)[j]);
            j++;
        }
        idx240[market] = j;
    }

    for (let i = startIdx; i < minLength; i++) {
        // For i > startIdx, incrementally grow arrays (O(1) per step)
        if (i > startIdx) {
            const currentTs = new Date(get15m(markets[0])[i].timestamp).getTime();
            for (const market of markets) {
                // Push new 15m candle
                slicedData[market][15].push(get15m(market)[i]);

                // Advance 240m pointer
                const candles240 = get240m(market);
                const ts240 = timestamps240[market];
                while (idx240[market] < ts240.length && ts240[idx240[market]] <= currentTs) {
                    slicedData[market][240].push(candles240[idx240[market]]);
                    idx240[market]++;
                }
            }
        }

        const result = strategy.onNewCandle(state, slicedData);

        // Calculate current portfolio value
        const currentPrice = get15m(currentAsset)[i].close;
        const currentValue = holdings * currentPrice;

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            const target = result.details.targetMarket;
            if (target !== currentAsset && candleData[target]) {
                const sellPrice = get15m(currentAsset)[i].close;
                const buyPrice = get15m(target)[i].close;

                const krwAfterSell = holdings * sellPrice * (1 - effectiveSlippage) * (1 - FEE_RATE);
                const effectiveBuyPrice = buyPrice * (1 + effectiveSlippage);
                holdings = (krwAfterSell * (1 - FEE_RATE)) / effectiveBuyPrice;

                trades.push({
                    idx: i,
                    timestamp: get15m(currentAsset)[i].timestamp,
                    action: 'SWITCH',
                    from: currentAsset,
                    to: target,
                    sellPrice,
                    buyPrice,
                });

                currentAsset = target;
            }
        }

        const value = holdings * get15m(currentAsset)[i].close;
        equityCurve.push(value);

        if (value > peak) peak = value;
        const dd = (peak - value) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const finalIdx = minLength - 1;
    const finalPrice = get15m(currentAsset)[finalIdx].close;
    const finalValue = holdings * finalPrice;
    const returnPct = ((finalValue - portfolio) / portfolio) * 100;

    // Per-market benchmarks: buy and hold
    const benchmarks = {};
    for (const market of markets) {
        const startP = startPrices[market];
        const endP = get15m(market)[finalIdx].close;
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
        executionMode,
        slippageRate: effectiveSlippage,
        feeRate: FEE_RATE,
        trades: trades.slice(-20),
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

    // Build candleData with nested timeframe structure
    const intervals = config.candleIntervals || [15, 240];
    const candleData = {};
    for (const market of config.markets) {
        const candles15 = store.getCandles(market, 15);
        if (candles15.length > 0) {
            candleData[market] = { 15: candles15 };
            for (const unit of intervals) {
                if (unit !== 15) {
                    candleData[market][unit] = store.getCandles(market, unit);
                }
            }
        }
    }

    const marketsLoaded = Object.keys(candleData);
    if (marketsLoaded.length < 2) {
        process.stderr.write(`[BACKTEST] Not enough candle data. Found: ${marketsLoaded.join(', ')}. Run candle-fetcher.js first.\n`);
        process.exit(1);
    }

    process.stderr.write(`[BACKTEST] Markets: ${marketsLoaded.join(', ')}, Intervals: ${intervals.join(', ')}\n`);

    const result = runBacktest(strategy, candleData, path.basename(resolvedPath));
    // stdout: pure JSON only (for piping to other scripts)
    console.log(JSON.stringify(result));
    saveResult(result);
}

module.exports = { runBacktest, compareStrategies, saveResult };
