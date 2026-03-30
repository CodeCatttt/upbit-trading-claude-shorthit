/**
 * day-trading-bot.js
 * High-frequency day trading bot using WebSocket real-time data.
 *
 * Architecture:
 * - WebSocket → real-time price/trade/orderbook
 * - CandleManager → builds 1m/5m candles from trades
 * - ScalpingStrategy → generates BUY/SELL/HOLD signals
 * - RiskManager → stop-loss, take-profit, daily limits, throttling
 * - UpbitAPI → order execution
 */

'use strict';

const fs = require('fs');
const path = require('path');
const api = require('./upbit-api');
const { refreshMarkets } = require('./market-selector');
const { UpbitWebSocket } = require('./websocket-client');
const { CandleManager } = require('./candle-manager');
const { RiskManager } = require('./risk-manager');
const { analyze, DEFAULT_CONFIG: STRATEGY_CONFIG } = require('../strategies/scalping-strategy');
const { calcATR } = require('./indicators');
const { createLogger } = require('../utils/logger');

const log = createLogger('DAY-BOT');

process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err.stack || err.message);
    process.exit(1);
});

// === Config ===
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');
const STATE_FILE = path.join(__dirname, '../../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../../data/bot-heartbeat.json');
const EXECUTION_LOG_FILE = path.join(__dirname, '../../data/execution-log.json');
const DAILY_STATS_FILE = path.join(__dirname, '../../data/daily-stats.json');

const MIN_ORDER_KRW = 5500;
const TRADE_RATIO = 0.995;
const ANALYSIS_INTERVAL_MS = 5000;  // Run strategy every 5 seconds
const HEARTBEAT_INTERVAL_MS = 60000; // Write heartbeat every 60 seconds
const STATUS_LOG_INTERVAL_MS = 300000; // Log status every 5 minutes
const SEED_CANDLES_1M = 100;
const SEED_CANDLES_5M = 100;

let lastHeartbeatTime = 0;
let lastStatusLogTime = 0;
let analysisCount = 0;

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        log.warn('Failed to load trading-config.json, using defaults');
        return {
            markets: ['KRW-BTC', 'KRW-ETH', 'KRW-SOL', 'KRW-XRP'],
            defaultAsset: 'KRW-BTC',
        };
    }
}

function getCurrencyFromMarket(market) {
    return market.replace('KRW-', '');
}

// === State ===
let state = {
    assetHeld: 'CASH',
    activeMarket: null,     // Which market we're actively trading
    entryPrice: null,
    lastTradeTime: 0,
};

const riskConfig = {
    maxDailyLossPct: 3,
    maxDailyTrades: 1000,
    slAtrMultiplier: 1.5,          // SL = ATR * 1.5
    tpAtrMultiplier: 2.0,          // Trailing TP activates at ATR * 2.0
    trailingPct: 0.2,              // Trail 0.2% from peak
    fallbackStopLossPct: 0.3,      // Fallback when no ATR data
    fallbackTakeProfitPct: 0.5,    // Fallback when no ATR data
    pauseDurationMs: 300000,       // 5 min pause
    pauseThresholdPct: 0.5,        // 0.5% loss in window triggers pause
    pauseWindowMs: 1800000,        // 30 min window
};

const riskManager = new RiskManager(riskConfig);
let candleManager = null;
let wsClient = null;
let analysisTimer = null;
let isProcessing = false;

// === Persistence ===
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (parsed.assetHeld) {
                state = { ...state, ...parsed };
            }
        }
    } catch (e) {
        log.error('Failed to parse state file:', e.message);
    }
}

function saveState() {
    try {
        const tmpFile = STATE_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
        fs.renameSync(tmpFile, STATE_FILE);
    } catch (e) {
        log.error('Failed to save state:', e.message);
    }
}

function writeHeartbeat(action, extra = {}) {
    try {
        const dir = path.dirname(HEARTBEAT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const heartbeat = {
            timestamp: new Date().toISOString(),
            mode: 'day-trading',
            state: state.assetHeld,
            activeMarket: state.activeMarket,
            lastAction: action,
            riskStatus: riskManager.getStatus(),
            ...extra,
        };
        fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
    } catch (e) {
        log.error('Failed to write heartbeat:', e.message);
    }
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
        if (logs.length > 500) logs = logs.slice(-500);
        fs.writeFileSync(EXECUTION_LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        log.error('Failed to write execution log:', e.message);
    }
}

function saveDailyStats() {
    try {
        const dir = path.dirname(DAILY_STATS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let stats = [];
        if (fs.existsSync(DAILY_STATS_FILE)) {
            stats = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
        }
        const status = riskManager.getStatus();
        stats.push({
            date: riskManager.dailyDate,
            timestamp: new Date().toISOString(),
            trades: status.dailyTradeCount,
            pnlKrw: status.dailyPnL,
            pnlPct: status.dailyPnLPct,
            winRate: status.winRate,
        });
        if (stats.length > 365) stats = stats.slice(-365);
        fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        log.error('Failed to save daily stats:', e.message);
    }
}

// === Core Trading Logic ===

/**
 * Select the best market to trade based on 5m volatility and volume.
 */
function selectMarket(markets) {
    let bestMarket = null;
    let bestScore = -Infinity;

    for (const market of markets) {
        const candles5m = candleManager.getCandles(market, 5);
        if (candles5m.length < 20) continue;

        // Score = volatility * volume (higher = better for scalping)
        const recent = candles5m.slice(-10);
        const avgRange = recent.reduce((sum, c) => sum + (c.high - c.low) / c.close, 0) / recent.length;
        const avgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
        const score = avgRange * avgVolume;

        if (score > bestScore) {
            bestScore = score;
            bestMarket = market;
        }
    }

    return bestMarket || markets[0];
}

/**
 * Execute a buy order.
 */
async function executeBuy(market) {
    const krw = await api.getBalance('KRW');
    const amt = Math.floor(krw * TRADE_RATIO);

    if (amt < MIN_ORDER_KRW) {
        log.warn(`Insufficient KRW for buy: ${amt}`);
        return false;
    }

    log.info(`BUY ${market}: ${amt} KRW`);
    const result = await api.buyMarketOrder(market, amt);
    if (!result) {
        log.error(`Buy failed for ${market}`);
        return false;
    }

    const price = await api.getCurrentPrice(market);
    state.assetHeld = market;
    state.activeMarket = market;
    state.entryPrice = price;
    state.lastTradeTime = Date.now();
    saveState();

    // Calculate ATR from 1m candles for dynamic SL/TP
    const candles1m = candleManager ? candleManager.getCandles(market, 1) : [];
    const atr = candles1m.length >= 15 ? calcATR(candles1m, 14) : null;

    riskManager.enterPosition(market, price, amt, atr);

    appendExecutionLog({
        action: 'BUY',
        market,
        price,
        amountKrw: amt,
    });

    return true;
}

/**
 * Execute a sell order.
 */
async function executeSell(market, reason) {
    const currency = getCurrencyFromMarket(market);
    const balance = await api.getBalance(currency);

    if (balance <= 0) {
        log.warn(`No balance to sell for ${currency}`);
        return false;
    }

    const priceBeforeSell = await api.getCurrentPrice(market);
    log.info(`SELL ${market}: ${balance} ${currency} (reason: ${reason})`);
    const result = await api.sellMarketOrder(market, balance);
    if (!result) {
        log.error(`Sell failed for ${market}`);
        return false;
    }

    // Calculate P&L
    const entryPrice = state.entryPrice || priceBeforeSell;
    const pnlPct = ((priceBeforeSell - entryPrice) / entryPrice) * 100;
    const pnlKrw = (priceBeforeSell - entryPrice) / entryPrice * (balance * entryPrice);

    riskManager.recordTrade(pnlPct, pnlKrw);

    state.assetHeld = 'CASH';
    state.entryPrice = null;
    state.lastTradeTime = Date.now();
    saveState();

    appendExecutionLog({
        action: 'SELL',
        market,
        price: priceBeforeSell,
        entryPrice,
        pnlPct: +pnlPct.toFixed(4),
        pnlKrw: +pnlKrw.toFixed(0),
        reason,
    });

    return true;
}

/**
 * Main analysis loop - called every ANALYSIS_INTERVAL_MS.
 */
async function runAnalysis() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const config = loadTradingConfig();
        const markets = config.markets;

        // Check risk limits
        const riskCheck = riskManager.canTrade();

        // If holding, always check stop-loss/take-profit regardless of pause
        if (state.assetHeld !== 'CASH' && state.activeMarket) {
            const market = state.activeMarket;
            const currentPrice = candleManager.getLatestPrice(market) || wsClient.getPrice(market);

            if (currentPrice > 0) {
                const exitCheck = riskManager.checkPositionExit(currentPrice);
                if (exitCheck.shouldExit) {
                    log.info(`Exit signal: ${exitCheck.reason} (PnL: ${exitCheck.pnlPct.toFixed(3)}%)`);
                    await executeSell(market, exitCheck.reason);
                    writeHeartbeat(exitCheck.reason);
                    isProcessing = false;
                    return;
                }
            }
        }

        if (!riskCheck.allowed) {
            writeHeartbeat('RISK_BLOCKED', { reason: riskCheck.reason });
            isProcessing = false;
            return;
        }

        // Select market to analyze
        const activeMarket = state.assetHeld !== 'CASH'
            ? state.activeMarket
            : selectMarket(markets);

        if (!activeMarket) {
            isProcessing = false;
            return;
        }

        // Get candle data + orderbook
        const candles1m = candleManager.getCandles(activeMarket, 1);
        const candles5m = candleManager.getCandles(activeMarket, 5);
        const orderbook = wsClient ? wsClient.getOrderbook(activeMarket) : null;

        // Run strategy with orderbook data
        const signal = analyze(candles1m, candles5m, STRATEGY_CONFIG, orderbook);

        analysisCount++;

        // Act on signal
        if (state.assetHeld === 'CASH' && signal.action === 'BUY') {
            log.info(`BUY signal for ${activeMarket} (score: ${signal.score})`, signal.signals);
            const success = await executeBuy(activeMarket);
            if (success) {
                writeHeartbeat('BUY', { market: activeMarket, signal });
            }
        } else if (state.assetHeld !== 'CASH' && signal.action === 'SELL') {
            // Check if current P&L covers round-trip fees before strategy sell
            // Stop-loss exits (handled by RiskManager above) bypass this check
            const MIN_PROFIT_TO_SELL = 0.15; // Must exceed 0.15% to cover 0.1% fees + margin
            const currentPrice = candleManager.getLatestPrice(activeMarket) || wsClient.getPrice(activeMarket);
            const pnlPct = state.entryPrice && currentPrice > 0
                ? ((currentPrice - state.entryPrice) / state.entryPrice) * 100
                : 0;

            if (pnlPct >= MIN_PROFIT_TO_SELL) {
                log.info(`SELL signal for ${activeMarket} (score: ${signal.score}, pnl: ${pnlPct.toFixed(3)}%)`, signal.signals);
                await executeSell(activeMarket, 'strategy_sell');
                writeHeartbeat('SELL', { market: activeMarket, signal });
            } else {
                log.info(`SELL signal suppressed: pnl ${pnlPct.toFixed(3)}% < ${MIN_PROFIT_TO_SELL}% min (score: ${signal.score})`);
            }
        }

        // Periodic heartbeat (every 60s)
        const now = Date.now();
        if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatTime = now;
            writeHeartbeat('MONITORING', {
                market: activeMarket,
                score: signal.score,
                action: signal.action,
                analysisCount,
            });
        }

        // Periodic status log (every 5min)
        if (now - lastStatusLogTime >= STATUS_LOG_INTERVAL_MS) {
            lastStatusLogTime = now;
            const status = riskManager.getStatus();
            const price = candleManager.getLatestPrice(activeMarket) || wsClient.getPrice(activeMarket);
            log.info(`[STATUS] state=${state.assetHeld}, market=${activeMarket}, price=${price}, score=${signal.score}, ` +
                `trades=${status.dailyTradeCount}, pnl=${status.dailyPnL.toFixed(0)}KRW, analyses=${analysisCount}`);
        }

    } catch (e) {
        log.error('Analysis error:', e.message);
    } finally {
        isProcessing = false;
    }
}

// === Initialization ===

async function seedCandleData(markets) {
    log.info(`Seeding candle data for ${markets.length} markets...`);

    // Seed sequentially in batches of 3 to avoid 429 rate limits
    const BATCH_SIZE = 3;
    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        const promises = [];
        for (const market of batch) {
            promises.push(
                api.getCandles(market, 1, SEED_CANDLES_1M)
                    .then(candles => candleManager.seedCandles(market, 1, candles))
                    .catch(e => log.warn(`Failed to seed 1m for ${market}: ${e.message}`))
            );
            promises.push(
                api.getCandles(market, 5, SEED_CANDLES_5M)
                    .then(candles => candleManager.seedCandles(market, 5, candles))
                    .catch(e => log.warn(`Failed to seed 5m for ${market}: ${e.message}`))
            );
        }
        await Promise.all(promises);
        if (i + BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, 500)); // 500ms between batches
        }
    }
    log.info('Candle seeding complete');
}

async function reconcileState(markets) {
    try {
        const balances = await api.getBalances();
        if (!balances || balances.length === 0) return;

        const holdings = [];
        for (const b of balances) {
            if (b.currency === 'KRW') continue;
            const market = `KRW-${b.currency}`;
            const bal = parseFloat(b.balance) + parseFloat(b.locked || '0');
            const avgPrice = parseFloat(b.avg_buy_price || '0');
            const value = bal * avgPrice;
            if (value > MIN_ORDER_KRW && markets.includes(market)) {
                holdings.push({ market, value, avgPrice });
            }
        }

        if (holdings.length > 0) {
            const top = holdings.sort((a, b) => b.value - a.value)[0];
            if (state.assetHeld !== top.market) {
                log.warn(`RECONCILE: State=${state.assetHeld} but actually holding ${top.market} (${Math.round(top.value)} KRW). Updating.`);
                state.assetHeld = top.market;
                state.activeMarket = top.market;
                state.entryPrice = top.avgPrice;
                saveState();
            }
            // Always sync RiskManager position for stop-loss/take-profit
            const reconCandles = candleManager ? candleManager.getCandles(top.market, 1) : [];
            const reconAtr = reconCandles.length >= 15 ? calcATR(reconCandles, 14) : null;
            riskManager.enterPosition(top.market, top.avgPrice, top.value, reconAtr);
        } else {
            // No crypto holdings — should be CASH
            if (state.assetHeld !== 'CASH') {
                log.warn(`RECONCILE: State=${state.assetHeld} but no crypto holdings. Updating to CASH.`);
                state.assetHeld = 'CASH';
                state.activeMarket = null;
                state.entryPrice = null;
                saveState();
            }
        }

        // Set daily start balance
        const totalValue = balances.reduce((sum, b) => {
            const bal = parseFloat(b.balance) + parseFloat(b.locked || '0');
            if (b.currency === 'KRW') return sum + bal;
            const avgPrice = parseFloat(b.avg_buy_price || '0');
            return sum + bal * avgPrice;
        }, 0);
        riskManager.setDailyStartBalance(totalValue);
        log.info(`Daily start balance: ${totalValue.toFixed(0)} KRW`);
    } catch (e) {
        log.error(`Reconciliation failed: ${e.message}`);
    }
}

async function start() {
    log.info('=== Upbit Day Trading Bot Starting ===');

    // Dynamic market selection on startup
    log.info('Selecting top markets by 24h volume...');
    await refreshMarkets(12);

    const config = loadTradingConfig();
    const markets = config.markets;

    loadState();
    log.info(`Markets: ${markets.join(', ')}`);
    log.info(`Initial state: ${state.assetHeld}`);
    log.info(`Risk config: stopLoss=${riskConfig.stopLossPct}%, takeProfit=${riskConfig.takeProfitPct}%, maxDailyLoss=${riskConfig.maxDailyLossPct}%, maxTrades=${riskConfig.maxDailyTrades}`);

    // Initialize candle manager
    candleManager = new CandleManager(markets);

    // Reconcile state with actual holdings
    await reconcileState(markets);

    // Seed historical candles
    await seedCandleData(markets);

    // Start WebSocket
    wsClient = new UpbitWebSocket(markets);

    wsClient.on('trade', (trade) => {
        candleManager.processTrade(trade.market, trade.price, trade.volume, trade.timestamp);
    });

    wsClient.on('connected', () => {
        log.info('WebSocket connected — starting analysis loop');
        // Start the analysis loop
        if (analysisTimer) clearInterval(analysisTimer);
        analysisTimer = setInterval(runAnalysis, ANALYSIS_INTERVAL_MS);
        // Run immediately
        runAnalysis();
    });

    await wsClient.connect();

    // Periodic daily stats save (every hour)
    setInterval(saveDailyStats, 3600000);

    // Periodic market refresh (every hour) — update WebSocket subscriptions too
    setInterval(async () => {
        const result = await refreshMarkets(12);
        if (result && wsClient) {
            // Re-initialize candle manager with new markets
            for (const m of result.added || []) {
                candleManager.seedCandles(m, 1, []);
                candleManager.seedCandles(m, 5, []);
            }
            wsClient.updateMarkets(result.markets);
            log.info(`Markets refreshed: ${result.markets.length} active`);
        }
    }, 3600000);

    // Graceful shutdown
    const shutdown = () => {
        log.info('Shutting down...');
        if (analysisTimer) clearInterval(analysisTimer);
        if (wsClient) wsClient.close();
        saveDailyStats();
        saveState();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Export for testing
module.exports = {
    start,
    runAnalysis,
    executeBuy,
    executeSell,
    selectMarket,
    // Expose internals for testing
    _getState: () => state,
    _setState: (s) => { Object.assign(state, s); },
    _setDeps: (deps) => {
        if (deps.candleManager) candleManager = deps.candleManager;
        if (deps.wsClient) wsClient = deps.wsClient;
        if (deps.riskManager) Object.assign(riskManager, deps.riskManager);
    },
    _getRiskManager: () => riskManager,
};

// Run if executed directly
if (require.main === module) {
    start().catch(e => {
        log.error('Fatal startup error:', e.message);
        process.exit(1);
    });
}
