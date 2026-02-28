/**
 * candle-store.js
 * JSON-based candle data storage with deduplication and merge.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CANDLE_DIR = path.join(__dirname, '../../data/candles');

function ensureDir() {
    if (!fs.existsSync(CANDLE_DIR)) fs.mkdirSync(CANDLE_DIR, { recursive: true });
}

function getFilePath(market, unit) {
    return path.join(CANDLE_DIR, `${market}_${unit}m.json`);
}

function load(market, unit) {
    const fp = getFilePath(market, unit);
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
        return null;
    }
}

function save(market, unit, candles) {
    ensureDir();
    const fp = getFilePath(market, unit);
    const data = {
        market,
        unit,
        lastFetched: new Date().toISOString(),
        candles,
    };
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function merge(existing, incoming) {
    const map = new Map();
    for (const c of existing) map.set(c.timestamp, c);
    for (const c of incoming) map.set(c.timestamp, c);
    return Array.from(map.values()).sort((a, b) =>
        new Date(a.timestamp) - new Date(b.timestamp)
    );
}

function getCandles(market, unit) {
    const data = load(market, unit);
    return data ? data.candles : [];
}

function appendCandles(market, unit, newCandles, maxKeep = 2000) {
    const data = load(market, unit);
    const existing = data ? data.candles : [];
    const merged = merge(existing, newCandles);
    const trimmed = merged.slice(-maxKeep);
    save(market, unit, trimmed);
    return trimmed;
}

module.exports = { load, save, merge, getCandles, appendCandles };
