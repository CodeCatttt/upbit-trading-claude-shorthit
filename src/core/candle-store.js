/**
 * candle-store.js
 * Persists 1m/5m candles to disk with 7-day rolling retention.
 * Used by CandleManager to flush closed candles, and by backtest to load history.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('CANDLE-STORE');

const STORE_DIR = path.join(__dirname, '../../data/candles');
const RETENTION_DAYS = 7;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getFilePath(market, interval) {
    return path.join(STORE_DIR, `${market}_${interval}m_history.json`);
}

/**
 * Append closed candles to the store file.
 * Deduplicates by timestamp and trims to retention period.
 * @param {string} market
 * @param {number} interval - 1 or 5
 * @param {object[]} newCandles - Array of closed candle objects
 */
function appendCandles(market, interval, newCandles) {
    if (!newCandles || newCandles.length === 0) return;

    ensureDir(STORE_DIR);
    const fp = getFilePath(market, interval);

    let existing = [];
    try {
        if (fs.existsSync(fp)) {
            existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
        }
    } catch (e) {
        log.warn(`Failed to read ${fp}, starting fresh: ${e.message}`);
    }

    // Merge and deduplicate by timestamp
    const byTs = new Map();
    for (const c of existing) byTs.set(c.timestamp, c);
    for (const c of newCandles) byTs.set(c.timestamp, c);

    // Sort chronologically
    let merged = Array.from(byTs.values())
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Trim to retention period
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 19);
    const beforeTrim = merged.length;
    merged = merged.filter(c => c.timestamp >= cutoffStr);

    // Write atomically
    const tmpFile = fp + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(merged));
    fs.renameSync(tmpFile, fp);

    const trimmed = beforeTrim - merged.length;
    if (trimmed > 0) {
        log.info(`${market} ${interval}m: +${newCandles.length} candles, trimmed ${trimmed} old, total ${merged.length}`);
    }
}

/**
 * Load stored candles for a market and interval.
 * @param {string} market
 * @param {number} interval
 * @returns {object[]} Candle array sorted chronologically
 */
function loadCandles(market, interval) {
    const fp = getFilePath(market, interval);
    try {
        if (fs.existsSync(fp)) {
            const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    } catch (e) {
        log.warn(`Failed to load ${fp}: ${e.message}`);
    }
    return [];
}

/**
 * Get stats about stored candle data.
 * @returns {object} { market: { interval: { count, oldest, newest } } }
 */
function getStoreStats() {
    ensureDir(STORE_DIR);
    const stats = {};
    try {
        const files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('_history.json'));
        for (const file of files) {
            const match = file.match(/^(.+)_(\d+)m_history\.json$/);
            if (!match) continue;
            const [, market, interval] = match;
            const candles = loadCandles(market, parseInt(interval));
            if (!stats[market]) stats[market] = {};
            stats[market][interval] = {
                count: candles.length,
                oldest: candles.length > 0 ? candles[0].timestamp : null,
                newest: candles.length > 0 ? candles[candles.length - 1].timestamp : null,
            };
        }
    } catch {}
    return stats;
}

/**
 * Run cleanup: remove candles older than retention period across all files.
 */
function cleanup() {
    ensureDir(STORE_DIR);
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 19);
    let totalTrimmed = 0;

    try {
        const files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('_history.json'));
        for (const file of files) {
            const fp = path.join(STORE_DIR, file);
            try {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                const before = data.length;
                const trimmed = data.filter(c => c.timestamp >= cutoffStr);
                if (trimmed.length < before) {
                    const tmpFile = fp + '.tmp';
                    fs.writeFileSync(tmpFile, JSON.stringify(trimmed));
                    fs.renameSync(tmpFile, fp);
                    totalTrimmed += before - trimmed.length;
                }
            } catch {}
        }
    } catch {}

    if (totalTrimmed > 0) {
        log.info(`Cleanup: trimmed ${totalTrimmed} candles older than ${RETENTION_DAYS} days`);
    }
    return totalTrimmed;
}

module.exports = { appendCandles, loadCandles, getStoreStats, cleanup, STORE_DIR, RETENTION_DAYS };
