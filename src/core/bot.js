/**
 * bot.js
 * Main trading bot - runs 24/7 via PM2.
 * Dynamically loads current-strategy.js, executes on 15-minute cron schedule.
 * Supports multi-asset trading via trading-config.json.
 */

'use strict';

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const api = require('./upbit-api');
const { executeSmartEntry } = require('../execution/smart-entry');
const { createLogger } = require('../utils/logger');

const log = createLogger('BOT');

// Log unhandled rejections/exceptions before PM2 restarts — aids crash diagnosis
process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err.stack || err.message);
    process.exit(1);
});

const MIN_ORDER_KRW = 5500;
const TRADE_RATIO = 0.995;

const STATE_FILE = path.join(__dirname, '../../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../../data/bot-heartbeat.json');
const EXECUTION_LOG_FILE = path.join(__dirname, '../../data/execution-log.json');
const STRATEGY_PATH = path.resolve(__dirname, '../strategies/current-strategy.js');
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        log.warn('Failed to load trading-config.json, using defaults');
        return {
            markets: ['KRW-BTC', 'KRW-ETH'],
            defaultAsset: 'KRW-BTC',
            candleIntervals: [15, 240],
        };
    }
}

function loadStrategy() {
    const resolved = require.resolve('../strategies/current-strategy');
    delete require.cache[resolved];
    // Also clear custom-indicators cache so strategy picks up latest deploy
    try {
        const customResolved = require.resolve('../strategies/custom-indicators');
        delete require.cache[customResolved];
    } catch (e) { /* custom-indicators may not exist */ }
    return require('../strategies/current-strategy');
}

let strategy = loadStrategy();
let state = strategy.createStrategyState();

if (fs.existsSync(STATE_FILE)) {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (parsed.assetHeld) {
            state = parsed;
            // Ensure required state properties exist
            if (state.candlesSinceLastTrade === undefined) state.candlesSinceLastTrade = 9999;
            if (state.peakPriceSinceEntry === undefined) state.peakPriceSinceEntry = null;
        }
    } catch (e) {
        log.error('Failed to parse state file, starting fresh.');
    }
}

function saveState() {
    // Atomic write: write to temp file then rename to prevent corruption
    // Exclude score cache — must be recomputed fresh after restart
    const { _cachedScoresKey, _cachedScores, ...persistState } = state;
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(persistState, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
}

function writeHeartbeat(lastAction) {
    const config = loadTradingConfig();
    const heartbeat = {
        timestamp: new Date().toISOString(),
        state: state.assetHeld,
        lastAction,
        markets: config.markets,
    };
    try {
        const dir = path.dirname(HEARTBEAT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
    } catch (e) {
        log.error('Failed to write heartbeat', e.message);
    }
}

function getCurrencyFromMarket(market) {
    return market.replace('KRW-', '');
}

function appendExecutionLog(entry) {
    try {
        const dir = path.dirname(EXECUTION_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let logs = [];
        if (fs.existsSync(EXECUTION_LOG_FILE)) {
            logs = JSON.parse(fs.readFileSync(EXECUTION_LOG_FILE, 'utf8'));
        }
        logs.push({ timestamp: new Date().toISOString(), ...entry });
        if (logs.length > 100) logs = logs.slice(-100);
        fs.writeFileSync(EXECUTION_LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        log.error('Failed to write execution log', e.message);
    }
}

async function fetchCandleData(markets, intervals) {
    const candleData = {};
    for (const market of markets) {
        candleData[market] = {};
    }

    // Fetch all candles in parallel
    const candlePromises = [];
    for (const market of markets) {
        for (const unit of intervals) {
            candlePromises.push(
                api.getCandles(market, unit, 100)
                    .then(candles => { candleData[market][unit] = candles; })
                    .catch(e => {
                        log.warn(`Failed to fetch candles for ${market} ${unit}m: ${e.message}`);
                        candleData[market][unit] = [];
                    })
            );
        }
    }
    await Promise.all(candlePromises);

    // Fetch orderbook trade intensity in parallel
    const obPromises = markets.map(market =>
        api.getOrderbook(market)
            .then(ob => {
                if (ob && ob.totalAskSize > 0) {
                    candleData[market]._tradeIntensity = +(ob.totalBidSize / ob.totalAskSize).toFixed(2);
                }
            })
            .catch(e => { log.warn(`Orderbook error for ${market}: ${e.message}`); })
    );
    await Promise.all(obPromises);

    return candleData;
}

async function runStrategyBoundary() {
    try {
        // Reload strategy and config each cycle to pick up deploys
        strategy = loadStrategy();
        const config = loadTradingConfig();
        const markets = config.markets;

        // Ensure current asset is always in the watched markets list
        let effectiveMarkets = markets;
        if (state.assetHeld !== 'CASH' && !markets.includes(state.assetHeld)) {
            log.warn(`Current asset ${state.assetHeld} not in markets list, adding temporarily.`);
            effectiveMarkets = [state.assetHeld, ...markets];
        }

        const intervals = config.candleIntervals || [15, 240];
        log.info(`Strategy check - Held: ${state.assetHeld}, Markets: ${effectiveMarkets.join(', ')}, Intervals: ${intervals.join(', ')}`);

        const candleData = await fetchCandleData(effectiveMarkets, intervals);

        // Run shadow strategies (paper trading, no real orders)
        try {
            const { runShadowCycle } = require('../batch/learning/shadow-manager');
            runShadowCycle(candleData);
        } catch (e) {
            // Shadow execution is non-critical
            if (e.code !== 'MODULE_NOT_FOUND') log.warn('Shadow cycle error:', e.message);
        }

        // Verify we have sufficient data for at least some markets (check 15m candles)
        const marketsWithData = Object.entries(candleData)
            .filter(([, intervals]) => intervals[15] && intervals[15].length >= 21);
        if (marketsWithData.length < 2) {
            log.warn('Insufficient candle data for markets.');
            writeHeartbeat('NONE');
            return;
        }

        // Re-entry from CASH — let strategy decide
        if (state.assetHeld === 'CASH') {
            log.info('In CASH state. Checking re-entry conditions...');
            // Save mutable state before strategy call — restore on failed buy
            const savedCounter = state.candlesSinceLastTrade;
            const savedPeak = state.peakPriceSinceEntry;
            const signal = strategy.onNewCandle(state, candleData);
            state.assetHeld = 'CASH'; // Always restore — bot controls state transitions

            if (signal.action === 'SWITCH' && signal.details && signal.details.targetMarket && signal.details.targetMarket !== 'CASH') {
                const targetMarket = signal.details.targetMarket;
                const krw = await api.getBalance('KRW');
                const amt = Math.floor(krw * TRADE_RATIO);

                if (amt > MIN_ORDER_KRW) {
                    log.info(`Re-entry: Buying ${getCurrencyFromMarket(targetMarket)}. Reason: ${signal.details.reason || 'strategy'}`);
                    const buyResult = await api.buyMarketOrder(targetMarket, amt);
                    if (!buyResult) {
                        log.error(`Re-entry buy failed for ${targetMarket}. Staying in CASH.`);
                        // Restore state counters — no trade happened
                        state.candlesSinceLastTrade = savedCounter;
                        state.peakPriceSinceEntry = savedPeak;
                        saveState();
                        writeHeartbeat('BUY_FAILED');
                        return;
                    }
                    state.assetHeld = targetMarket;
                    state.candlesSinceLastTrade = 0;
                    state.peakPriceSinceEntry = null;
                    saveState();
                    appendExecutionLog({
                        from: 'CASH',
                        to: targetMarket,
                        mode: 'market',
                        executed: true,
                        method: 'reentry',
                        reason: signal.details.reason || 'strategy',
                    });
                    writeHeartbeat('REENTRY');
                } else {
                    log.warn('Insufficient KRW for re-entry.');
                    // Restore state counters and persist
                    state.candlesSinceLastTrade = savedCounter;
                    state.peakPriceSinceEntry = savedPeak;
                    saveState();
                    writeHeartbeat('CASH_LOW_BALANCE');
                }
            } else {
                log.info(`Staying in CASH. ${signal.details ? signal.details.reason || '' : ''}`);
                saveState(); // Persist candlesSinceLastTrade counter to survive PM2 restarts
                writeHeartbeat('CASH_HOLD');
            }
            return;
        }

        // Save full mutable state BEFORE strategy call — restore on failed trade
        const savedState = {
            assetHeld: state.assetHeld,
            candlesSinceLastTrade: state.candlesSinceLastTrade,
            peakPriceSinceEntry: state.peakPriceSinceEntry,
        };
        let result;
        try {
            result = strategy.onNewCandle(state, candleData);
        } catch (stratErr) {
            log.error(`Strategy onNewCandle error: ${stratErr.message}`);
            // Restore state — strategy may have partially mutated it
            state.assetHeld = savedState.assetHeld;
            state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
            state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;
            saveState();
            writeHeartbeat('STRATEGY_ERROR');
            return;
        }
        // Bot always controls assetHeld — strategy must not change it
        state.assetHeld = savedState.assetHeld;

        log.info(`Action: [${result.action}]`, result.details);

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            // Restore pre-trade counters — only persist changes after trade succeeds
            state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
            state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;

            const targetMarket = result.details.targetMarket;

            // SELL_TO_CASH: sell current asset, hold KRW
            if (targetMarket === 'CASH' && state.assetHeld !== 'CASH') {
                const currentCurrency = getCurrencyFromMarket(state.assetHeld);
                const previousAsset = state.assetHeld;
                try {
                    const balance = await api.getBalance(currentCurrency);
                    if (balance > 0) {
                        log.info(`SELL_TO_CASH: Selling ${balance} ${currentCurrency}...`);
                        const sellResult = await api.sellMarketOrder(state.assetHeld, balance);
                        if (!sellResult) {
                            log.error(`SELL_TO_CASH failed for ${currentCurrency}. Keeping position.`);
                            // Restore state — no trade happened
                            state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
                            state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;
                            saveState();
                            writeHeartbeat('SELL_FAILED');
                            return;
                        }
                        state.assetHeld = 'CASH';
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                        saveState();
                        log.info(`SELL_TO_CASH complete: ${previousAsset} → CASH`);
                        appendExecutionLog({
                            from: previousAsset,
                            to: 'CASH',
                            mode: 'market',
                            executed: true,
                            method: 'sell_to_cash',
                            reason: result.details.reason || 'risk management',
                        });
                    }
                } catch (cashErr) {
                    log.error(`SELL_TO_CASH error: ${cashErr.message}`);
                }
                writeHeartbeat('SELL_TO_CASH');
                return;
            }

            const targetCurrency = getCurrencyFromMarket(targetMarket);
            const currentCurrency = getCurrencyFromMarket(state.assetHeld);
            const previousAsset = state.assetHeld;
            const executionMode = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.executionMode) || 'market';

            try {
                // Sell current asset (always immediate)
                if (state.assetHeld !== 'CASH') {
                    const balance = await api.getBalance(currentCurrency);
                    if (balance > 0) {
                        log.info(`Selling ${balance} ${currentCurrency} to buy ${targetCurrency}...`);
                        const sellResult = await api.sellMarketOrder(state.assetHeld, balance);
                        if (!sellResult) {
                            log.error(`Sell failed for ${currentCurrency}. Aborting SWITCH.`);
                            // Restore state — no trade happened
                            state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
                            state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;
                            saveState();
                            writeHeartbeat('SELL_FAILED');
                            return;
                        }
                        // Wait for KRW settlement, then verify
                        await new Promise(r => setTimeout(r, 3000));
                        let krwSettled = await api.getBalance('KRW');
                        if (krwSettled < MIN_ORDER_KRW) {
                            log.warn('KRW not settled after 3s, waiting 5s more...');
                            await new Promise(r => setTimeout(r, 5000));
                            krwSettled = await api.getBalance('KRW');
                        }
                    }
                }

                const krwBalance = await api.getBalance('KRW');

                if (executionMode === 'smart' && strategy.DEFAULT_CONFIG.smartEntry) {
                    // Smart execution: monitor and enter at optimal price
                    log.info(`Smart entry mode for ${targetMarket}`);
                    const smartResult = await executeSmartEntry(
                        targetMarket, krwBalance, strategy.DEFAULT_CONFIG.smartEntry, TRADE_RATIO, MIN_ORDER_KRW
                    );

                    appendExecutionLog({
                        from: previousAsset,
                        to: targetMarket,
                        mode: 'smart',
                        ...smartResult,
                    });

                    if (smartResult.executed) {
                        state.assetHeld = targetMarket;
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                        saveState();
                        log.info(`SWITCH complete (smart, ${smartResult.method}): ${previousAsset} → ${targetMarket}, improvement: ${smartResult.improvement}%`);
                    } else {
                        log.error(`Smart entry failed for ${targetMarket}. Entering CASH state.`);
                        state.assetHeld = 'CASH';
                        // Sell already succeeded — we're in CASH now, reset counters for CASH re-entry
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                        saveState();
                        writeHeartbeat('BUY_FAILED');
                        return;
                    }
                } else {
                    // Market execution: immediate buy
                    const buyAmount = Math.floor(krwBalance * TRADE_RATIO);
                    if (buyAmount > MIN_ORDER_KRW) {
                        const buyResult = await api.buyMarketOrder(targetMarket, buyAmount);
                        if (!buyResult) {
                            log.error(`Buy failed for ${targetMarket}. Entering CASH state.`);
                            state.assetHeld = 'CASH';
                            // Sell already succeeded — we're in CASH now, reset counters for CASH re-entry
                            state.candlesSinceLastTrade = 0;
                            state.peakPriceSinceEntry = null;
                            saveState();
                            writeHeartbeat('BUY_FAILED');
                            return;
                        }
                        state.assetHeld = targetMarket;
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                        saveState();
                        log.info(`SWITCH complete (market): ${previousAsset} → ${targetMarket}`);
                        appendExecutionLog({
                            from: previousAsset,
                            to: targetMarket,
                            mode: 'market',
                            executed: true,
                            method: 'market',
                            improvement: 0,
                            waitedMs: 0,
                        });
                    } else {
                        log.error(`Buy failed: insufficient KRW (${buyAmount}). Entering CASH state.`);
                        state.assetHeld = 'CASH';
                        // Sell already succeeded — we're in CASH now, reset counters for CASH re-entry
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                        saveState();
                        writeHeartbeat('BUY_FAILED');
                        return;
                    }
                }
            } catch (switchErr) {
                log.error(`SWITCH execution error: ${switchErr.message}`);
                // Determine actual portfolio state by checking both KRW and target asset
                try {
                    const krwBal = await api.getBalance('KRW').catch(() => 0);
                    const targetBal = await api.getBalance(targetCurrency).catch(() => 0);
                    if (targetBal > 0) {
                        // Target asset was bought — update state accordingly
                        state.assetHeld = targetMarket;
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                    } else if (krwBal > MIN_ORDER_KRW) {
                        // No target asset but have KRW — we're in CASH
                        state.assetHeld = 'CASH';
                        state.candlesSinceLastTrade = 0;
                        state.peakPriceSinceEntry = null;
                    } else {
                        // Check if still holding original asset
                        const origBal = await api.getBalance(currentCurrency).catch(() => 0);
                        if (origBal > 0) {
                            // Still holding original — restore state
                            state.assetHeld = savedState.assetHeld;
                            state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
                            state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;
                        } else {
                            // Can't determine — default to CASH
                            log.error('Cannot determine portfolio position after SWITCH error');
                            state.assetHeld = 'CASH';
                            state.candlesSinceLastTrade = 0;
                            state.peakPriceSinceEntry = null;
                        }
                    }
                } catch (recoveryErr) {
                    log.error(`SWITCH recovery error: ${recoveryErr.message}`);
                    state.candlesSinceLastTrade = savedState.candlesSinceLastTrade;
                    state.peakPriceSinceEntry = savedState.peakPriceSinceEntry;
                }
                saveState();
            }
        } else {
            // HOLD/NONE: preserve strategy's state updates (peak tracking, counter increment)
            saveState();
        }

        writeHeartbeat(result.action);
    } catch (e) {
        log.error('runStrategyBoundary Error:', e.message);
        writeHeartbeat('ERROR');
    }
}

// Reconcile bot state with actual account holdings on startup
async function reconcileState() {
    try {
        const config = loadTradingConfig();
        const balances = await api.getBalances();
        if (!balances || balances.length === 0) return;

        // Find non-KRW assets worth more than MIN_ORDER_KRW
        const holdings = [];
        for (const b of balances) {
            if (b.currency === 'KRW') continue;
            const market = `KRW-${b.currency}`;
            const bal = parseFloat(b.balance) + parseFloat(b.locked || '0');
            const avgPrice = parseFloat(b.avg_buy_price || '0');
            const value = bal * avgPrice;
            if (value > MIN_ORDER_KRW && config.markets.includes(market)) {
                holdings.push({ market, value });
            }
        }

        const krwBal = balances.find(b => b.currency === 'KRW');
        const krwTotal = krwBal ? parseFloat(krwBal.balance) + parseFloat(krwBal.locked || '0') : 0;

        if (state.assetHeld === 'CASH' && holdings.length > 0) {
            // State says CASH but we're holding a coin — fix it
            const top = holdings.sort((a, b) => b.value - a.value)[0];
            log.warn(`RECONCILE: State says CASH but account holds ${top.market} (${Math.round(top.value)} KRW). Updating state.`);
            state.assetHeld = top.market;
            state.candlesSinceLastTrade = 9999; // unknown, use safe default
            state.peakPriceSinceEntry = null;
            saveState();
        } else if (state.assetHeld !== 'CASH' && holdings.length === 0 && krwTotal > MIN_ORDER_KRW) {
            // State says holding a coin but we only have KRW — fix it
            log.warn(`RECONCILE: State says ${state.assetHeld} but account only has KRW (${Math.round(krwTotal)}). Updating to CASH.`);
            state.assetHeld = 'CASH';
            state.candlesSinceLastTrade = 9999;
            state.peakPriceSinceEntry = null;
            saveState();
        } else if (state.assetHeld !== 'CASH' && holdings.length > 0) {
            const actualMarket = holdings.sort((a, b) => b.value - a.value)[0].market;
            if (state.assetHeld !== actualMarket) {
                log.warn(`RECONCILE: State says ${state.assetHeld} but account holds ${actualMarket}. Updating state.`);
                state.assetHeld = actualMarket;
                state.candlesSinceLastTrade = 9999;
                state.peakPriceSinceEntry = null;
                saveState();
            }
        }

        // Initialize peak from current price if holding asset with null peak (after reconciliation or crash recovery)
        if (state.assetHeld !== 'CASH' && state.peakPriceSinceEntry === null) {
            try {
                const price = await api.getCurrentPrice(state.assetHeld);
                if (price > 0) {
                    state.peakPriceSinceEntry = price;
                    saveState();
                    log.info(`Initialized peakPriceSinceEntry from current price: ${price}`);
                }
            } catch (e) {
                log.warn(`Failed to initialize peak price: ${e.message}`);
            }
        }
    } catch (e) {
        log.error(`Reconciliation failed: ${e.message}`);
    }
}

// Schedule: second 10 of minutes 0,15,30,45
cron.schedule('10 0,15,30,45 * * * *', runStrategyBoundary);

const config = loadTradingConfig();
log.info('Upbit Multi-Asset Trading Bot Started!');
log.info(`Markets: ${config.markets.join(', ')}`);
log.info(`Initial State: Holding ${state.assetHeld}`);

// Reconcile then run immediately on start
reconcileState().then(() => {
    log.info(`Reconciled State: Holding ${state.assetHeld}`);
    runStrategyBoundary();
}).catch(e => {
    log.error('Startup reconciliation error:', e.message);
    runStrategyBoundary();
});