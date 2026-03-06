/**
 * performance-tracker.js
 * Tracks real portfolio performance vs BTC buy-and-hold benchmark.
 * Records daily entries to data/performance-ledger.json.
 *
 * Usage:
 *   node src/batch/performance-tracker.js          — record today's entry
 *   node src/batch/performance-tracker.js --summary — print summary
 */

'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../core/upbit-api');
const { createLogger } = require('../utils/logger');

const log = createLogger('PERF-TRACKER');

const LEDGER_FILE = path.join(__dirname, '../../data/performance-ledger.json');
const STATE_FILE = path.join(__dirname, '../../bot-state.json');
const EXECUTION_LOG_FILE = path.join(__dirname, '../../data/execution-log.json');

function loadLedger() {
    try {
        if (fs.existsSync(LEDGER_FILE)) {
            return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
        }
    } catch {}
    return { entries: [], initialValue: null, initialBtcPrice: null, summary: null };
}

function saveLedger(ledger) {
    const dir = path.dirname(LEDGER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = LEDGER_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmpFile, LEDGER_FILE);
}

function loadJSON(fp) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return null;
}

/**
 * Record today's portfolio snapshot.
 * Computes alpha vs BTC buy-and-hold and running MDD.
 */
async function recordDaily() {
    const ledger = loadLedger();
    const today = new Date().toISOString().slice(0, 10);

    // Skip if already recorded today
    if (ledger.entries.length > 0 && ledger.entries[ledger.entries.length - 1].date === today) {
        log.info(`Already recorded for ${today}, skipping.`);
        return ledger;
    }

    // Get current portfolio value
    const balances = await api.getBalances();
    let totalValueKrw = 0;
    for (const b of balances) {
        // Include both available and locked balance
        const bal = parseFloat(b.balance) + parseFloat(b.locked || '0');
        if (bal === 0) continue;
        if (b.currency === 'KRW') {
            totalValueKrw += bal;
        } else {
            const market = `KRW-${b.currency}`;
            try {
                const price = await api.getCurrentPrice(market);
                if (price && price > 0) totalValueKrw += bal * price;
            } catch {}
        }
    }

    // Get current BTC price
    const btcPrice = await api.getCurrentPrice('KRW-BTC');

    // Bot state
    const botState = loadJSON(STATE_FILE);
    const assetHeld = botState ? botState.assetHeld : 'unknown';

    // Initialize on first recording
    if (ledger.initialValue === null) {
        ledger.initialValue = totalValueKrw;
        ledger.initialBtcPrice = btcPrice;
    }

    // Calculate BTC benchmark (what the portfolio would be worth if held BTC from start)
    const btcUnitsAtStart = ledger.initialValue / ledger.initialBtcPrice;
    const btcBenchmarkValue = Math.floor(btcUnitsAtStart * btcPrice);

    // Calculate returns
    const portfolioReturn = ((totalValueKrw - ledger.initialValue) / ledger.initialValue * 100);
    const btcReturn = ((btcBenchmarkValue - ledger.initialValue) / ledger.initialValue * 100);
    const alpha = +(portfolioReturn - btcReturn).toFixed(2);

    // Calculate MDD (peak to current)
    let peakValue = ledger.initialValue;
    for (const e of ledger.entries) {
        if (e.portfolioValueKrw > peakValue) peakValue = e.portfolioValueKrw;
    }
    if (totalValueKrw > peakValue) peakValue = totalValueKrw;
    const mdd = peakValue > 0 ? +((peakValue - totalValueKrw) / peakValue * 100).toFixed(2) : 0;

    // Count today's trades
    const execLog = loadJSON(EXECUTION_LOG_FILE) || [];
    const todayTrades = execLog.filter(e => e.timestamp && e.timestamp.startsWith(today)).length;

    const entry = {
        date: today,
        portfolioValueKrw: Math.floor(totalValueKrw),
        assetHeld,
        btcBenchmark: btcBenchmarkValue,
        alpha,
        mdd,
        trades: todayTrades,
    };

    ledger.entries.push(entry);

    // Keep max 365 daily entries
    if (ledger.entries.length > 365) {
        ledger.entries = ledger.entries.slice(-365);
    }

    // Update summary
    ledger.summary = computeSummary(ledger);

    saveLedger(ledger);
    log.info(`Recorded: ${today} portfolio=${totalValueKrw.toLocaleString()} alpha=${alpha}% mdd=${mdd}%`);
    return ledger;
}

/**
 * Compute aggregate summary from all entries.
 */
function computeSummary(ledger) {
    if (ledger.entries.length === 0 || !ledger.initialValue) return null;

    const latest = ledger.entries[ledger.entries.length - 1];
    const totalReturnPct = +((latest.portfolioValueKrw - ledger.initialValue) / ledger.initialValue * 100).toFixed(2);
    const btcReturnPct = +((latest.btcBenchmark - ledger.initialValue) / ledger.initialValue * 100).toFixed(2);
    const alphaPct = +(totalReturnPct - btcReturnPct).toFixed(2);

    // Max MDD across all entries
    const maxMdd = ledger.entries.reduce((max, e) => Math.max(max, e.mdd || 0), 0);

    // Total trades
    const totalTrades = ledger.entries.reduce((sum, e) => sum + (e.trades || 0), 0);

    // Win rate: days where alpha increased
    let wins = 0;
    for (let i = 1; i < ledger.entries.length; i++) {
        const prev = ledger.entries[i - 1];
        const curr = ledger.entries[i];
        if (curr.portfolioValueKrw > prev.portfolioValueKrw) wins++;
    }
    const winRate = ledger.entries.length > 1
        ? +(wins / (ledger.entries.length - 1)).toFixed(4)
        : null;

    return {
        totalReturnPct,
        btcReturnPct,
        alphaPct,
        maxMdd,
        totalTrades,
        winRate,
        daysTracked: ledger.entries.length,
    };
}

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--summary') {
        const ledger = loadLedger();
        console.log(JSON.stringify(ledger.summary || 'No data yet.', null, 2));
    } else {
        recordDaily()
            .then(l => console.log(JSON.stringify(l.summary || 'First recording.', null, 2)))
            .catch(e => { log.error('Fatal:', e.message); process.exit(1); });
    }
}

module.exports = { recordDaily, loadLedger, computeSummary };
