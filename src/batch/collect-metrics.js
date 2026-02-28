/**
 * collect-metrics.js
 * Collects portfolio, strategy, market, and bot health data.
 * Enhanced with Sharpe ratio, win rate, rolling returns, trade statistics.
 * Supports multi-asset via trading-config.json.
 * Outputs JSON to data/metrics/YYYY-MM-DD-HHmm.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../upbit-api');
const { createLogger } = require('../utils/logger');

const log = createLogger('METRICS');

const STATE_FILE = path.join(__dirname, '../../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../../data/bot-heartbeat.json');
const STRATEGY_FILE = path.join(__dirname, '../strategies/current-strategy.js');
const METRICS_DIR = path.join(__dirname, '../../data/metrics');
const DEPLOY_LOG = path.join(__dirname, '../../deploy-log.json');
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJSON(fp) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return null;
}

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return { markets: ['KRW-BTC', 'KRW-ETH'], candleIntervals: [15, 240] };
    }
}

/**
 * Calculate Sharpe ratio from deploy log entries.
 * Uses portfolio value changes between deploys as returns.
 */
function calcSharpeRatio(deployLog, days = 30) {
    if (!deployLog || deployLog.length < 3) return null;

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recentDeploys = deployLog.filter(d =>
        d.timestamp && new Date(d.timestamp).getTime() > cutoff && d.backtestComparison
    );

    if (recentDeploys.length < 2) return null;

    const returns = recentDeploys
        .filter(d => d.backtestComparison && typeof d.backtestComparison.returnImprovement === 'number')
        .map(d => d.backtestComparison.returnImprovement / 100);

    if (returns.length < 2) return null;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return null;
    return +(mean / stdDev).toFixed(4);
}

/**
 * Calculate win rate from deploy log.
 * A "win" is a deploy where returnImprovement > 0.
 */
function calcWinRate(deployLog) {
    if (!deployLog || deployLog.length === 0) return null;

    const successDeploys = deployLog.filter(d => d.success && d.backtestComparison);
    if (successDeploys.length === 0) return null;

    const wins = successDeploys.filter(d => d.backtestComparison.returnImprovement > 0).length;
    return {
        winRate: +(wins / successDeploys.length).toFixed(4),
        wins,
        total: successDeploys.length,
    };
}

/**
 * Calculate rolling returns from metrics history.
 */
function calcRollingReturns(metricsDir) {
    if (!fs.existsSync(metricsDir)) return null;

    const files = fs.readdirSync(metricsDir)
        .filter(f => f.endsWith('.json'))
        .sort();

    if (files.length < 2) return null;

    const now = Date.now();
    const day7 = now - 7 * 24 * 60 * 60 * 1000;
    const day30 = now - 30 * 24 * 60 * 60 * 1000;

    const latestMetrics = safeReadJSON(path.join(metricsDir, files[files.length - 1]));
    if (!latestMetrics || !latestMetrics.portfolio) return null;

    const currentValue = latestMetrics.portfolio.totalValueKrw;
    let value7d = null;
    let value30d = null;

    for (const f of files) {
        const m = safeReadJSON(path.join(metricsDir, f));
        if (!m || !m.timestamp || !m.portfolio) continue;

        const ts = new Date(m.timestamp).getTime();
        if (ts <= day7 && (value7d === null || ts > new Date(value7d.timestamp).getTime())) {
            value7d = { value: m.portfolio.totalValueKrw, timestamp: m.timestamp };
        }
        if (ts <= day30 && (value30d === null || ts > new Date(value30d.timestamp).getTime())) {
            value30d = { value: m.portfolio.totalValueKrw, timestamp: m.timestamp };
        }
    }

    return {
        rolling7d: value7d ? +((currentValue - value7d.value) / value7d.value * 100).toFixed(4) : null,
        rolling30d: value30d ? +((currentValue - value30d.value) / value30d.value * 100).toFixed(4) : null,
    };
}

/**
 * Calculate trade statistics from recent orders.
 */
function calcTradeStats(recentOrders, deployLog) {
    if (!deployLog || deployLog.length === 0) return null;

    const successDeploys = deployLog.filter(d => d.success);
    const totalDeploys = successDeploys.length;

    // Average hold duration (estimated from deploy intervals)
    let avgHoldHours = null;
    if (successDeploys.length >= 2) {
        const intervals = [];
        for (let i = 1; i < successDeploys.length; i++) {
            const diff = new Date(successDeploys[i].timestamp).getTime() -
                         new Date(successDeploys[i - 1].timestamp).getTime();
            intervals.push(diff / (1000 * 60 * 60)); // hours
        }
        avgHoldHours = +(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1);
    }

    return {
        totalDeploys,
        avgHoldHours,
    };
}

async function collectMetrics() {
    log.info('Collecting metrics...');

    const tradingConfig = loadTradingConfig();
    const markets = tradingConfig.markets;

    // 1. Portfolio
    const balances = await api.getBalances();

    const marketPrices = {};
    for (const market of markets) {
        try {
            marketPrices[market] = await api.getCurrentPrice(market);
        } catch (e) {
            log.warn(`Failed to get price for ${market}: ${e.message}`);
        }
    }

    let totalValueKrw = 0;
    const holdings = [];
    for (const b of balances) {
        const bal = parseFloat(b.balance);
        if (bal === 0) continue;
        if (b.currency === 'KRW') {
            totalValueKrw += bal;
            holdings.push({ currency: 'KRW', balance: bal, valueKrw: bal });
        } else {
            const market = `KRW-${b.currency}`;
            let price = marketPrices[market];
            if (!price) {
                try { price = await api.getCurrentPrice(market); } catch { continue; }
            }
            const val = bal * price;
            totalValueKrw += val;
            holdings.push({
                currency: b.currency,
                balance: bal,
                avgBuyPrice: parseFloat(b.avg_buy_price),
                currentPrice: price,
                valueKrw: val,
                pnlPct: ((price - parseFloat(b.avg_buy_price)) / parseFloat(b.avg_buy_price) * 100),
            });
        }
    }

    // 2. Current strategy (resolve re-exports to get actual code)
    let strategySource = '';
    try {
        strategySource = fs.readFileSync(STRATEGY_FILE, 'utf8');
        const reExportMatch = strategySource.match(/module\.exports\s*=\s*require\(['"](\.\/[^'"]+)['"]\)/);
        if (reExportMatch) {
            const actualPath = path.resolve(path.dirname(STRATEGY_FILE), reExportMatch[1]);
            const candidates = [actualPath, actualPath + '.js'];
            for (const cp of candidates) {
                if (fs.existsSync(cp)) {
                    strategySource = fs.readFileSync(cp, 'utf8');
                    break;
                }
            }
        }
    } catch {}

    // 3. Recent trades
    const recentOrders = await api.getRecentOrders(10);

    // 4. Bot state & health
    const botState = safeReadJSON(STATE_FILE);
    const heartbeat = safeReadJSON(HEARTBEAT_FILE);
    const heartbeatAge = heartbeat
        ? (Date.now() - new Date(heartbeat.timestamp).getTime()) / 1000
        : null;
    const botHealthy = heartbeatAge !== null && heartbeatAge < 1200; // 20 min

    // 5. Market data — all watched markets
    const marketData = {};
    for (const market of markets) {
        const price = marketPrices[market];
        if (price) {
            // Get 24h change via simple calculation from candle data
            let change24h = null;
            try {
                const candles = await api.getCandles(market, 60, 24);
                if (candles.length >= 24) {
                    const oldPrice = candles[0].close;
                    change24h = +((price - oldPrice) / oldPrice * 100).toFixed(2);
                }
            } catch {}

            marketData[market] = {
                price,
                change24h,
            };
        }
    }

    // 6. Deploy history & enhanced metrics
    const deployLog = safeReadJSON(DEPLOY_LOG) || [];
    const lastDeploy = deployLog.length > 0 ? deployLog[deployLog.length - 1] : null;

    const sharpeRatio = calcSharpeRatio(deployLog);
    const winRate = calcWinRate(deployLog);
    const rollingReturns = calcRollingReturns(METRICS_DIR);
    const tradeStats = calcTradeStats(recentOrders, deployLog);

    const metrics = {
        timestamp: new Date().toISOString(),
        portfolio: {
            totalValueKrw: Math.floor(totalValueKrw),
            holdings,
        },
        strategy: {
            file: 'current-strategy.js',
            source: strategySource,
            lastDeploy,
        },
        recentOrders: recentOrders.slice(0, 10).map(o => ({
            market: o.market,
            side: o.side,
            price: o.price,
            volume: o.volume,
            created_at: o.created_at,
        })),
        bot: {
            state: botState,
            heartbeat,
            heartbeatAgeSec: heartbeatAge ? Math.floor(heartbeatAge) : null,
            healthy: botHealthy,
        },
        market: marketData,
        tradingConfig: {
            markets,
            candleIntervals: tradingConfig.candleIntervals,
        },
        enhanced: {
            sharpeRatio,
            winRate,
            rollingReturns,
            tradeStats,
        },
    };

    // Save
    ensureDir(METRICS_DIR);
    const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const filename = `${ts}.json`;
    const fp = path.join(METRICS_DIR, filename);
    fs.writeFileSync(fp, JSON.stringify(metrics, null, 2));

    log.info(`Metrics saved: ${filename}`);
    return metrics;
}

if (require.main === module) {
    collectMetrics()
        .then(m => { console.log(JSON.stringify(m, null, 2)); })
        .catch(e => { log.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { collectMetrics };
