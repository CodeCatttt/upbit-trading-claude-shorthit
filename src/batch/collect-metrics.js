/**
 * collect-metrics.js
 * Collects portfolio, strategy, market, and bot health data.
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

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJSON(fp) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return null;
}

async function collectMetrics() {
    log.info('Collecting metrics...');

    // 1. Portfolio
    const balances = await api.getBalances();
    const btcPrice = await api.getCurrentPrice('KRW-BTC');
    const ethPrice = await api.getCurrentPrice('KRW-ETH');

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
            const price = await api.getCurrentPrice(market);
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

    // 2. Current strategy
    let strategySource = '';
    try {
        strategySource = fs.readFileSync(STRATEGY_FILE, 'utf8');
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

    // 5. Market data
    const btcEthRatio = btcPrice && ethPrice ? btcPrice / ethPrice : null;

    // 6. Deploy history
    const deployLog = safeReadJSON(DEPLOY_LOG) || [];
    const lastDeploy = deployLog.length > 0 ? deployLog[deployLog.length - 1] : null;

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
        market: {
            btcPrice,
            ethPrice,
            btcEthRatio,
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
