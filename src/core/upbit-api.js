/**
 * upbit-api.js
 * Unified Upbit API wrapper - shared across bot, batch, and utilities.
 */

'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const querystring = require('querystring');
const uuid = require('uuid');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const access_key = process.env.UPBIT_ACCESS_KEY;
const secret_key = process.env.UPBIT_SECRET_KEY;
const server_url = 'https://api.upbit.com';

function getHeaders(body = null) {
    const payload = { access_key, nonce: uuid.v4() };
    if (body) {
        const query = querystring.encode(body);
        const hash = crypto.createHash('sha512').update(query).digest('hex');
        payload.query_hash = hash;
        payload.query_hash_alg = 'SHA512';
    }
    const token = jwt.sign(payload, secret_key);
    return { Authorization: `Bearer ${token}` };
}

async function getBalance(currency) {
    try {
        const res = await axios.get(`${server_url}/v1/accounts`, { headers: getHeaders() });
        const account = res.data.find(b => b.currency === currency);
        return account ? parseFloat(account.balance) : 0;
    } catch (e) {
        console.error(`Error getBalance for ${currency}:`, e.response?.data || e.message);
        return 0;
    }
}

async function getBalances() {
    try {
        const res = await axios.get(`${server_url}/v1/accounts`, { headers: getHeaders() });
        return res.data;
    } catch (e) {
        console.error('Error getBalances:', e.response?.data || e.message);
        return [];
    }
}

async function getCandles(market, minutes, count) {
    try {
        const res = await axios.get(
            `${server_url}/v1/candles/minutes/${minutes}?market=${market}&count=${count}`
        );
        return res.data.reverse().map(c => ({
            open: c.opening_price,
            high: c.high_price,
            low: c.low_price,
            close: c.trade_price,
            volume: c.candle_acc_trade_volume,
            timestamp: c.candle_date_time_kst,
        }));
    } catch (e) {
        console.error(`Error getCandles for ${market}:`, e.message);
        return [];
    }
}

async function getCandlesPaginated(market, minutes, count, to = null) {
    try {
        let url = `${server_url}/v1/candles/minutes/${minutes}?market=${market}&count=${count}`;
        if (to) url += `&to=${to}`;
        const res = await axios.get(url);
        return res.data.reverse().map(c => ({
            open: c.opening_price,
            high: c.high_price,
            low: c.low_price,
            close: c.trade_price,
            volume: c.candle_acc_trade_volume,
            timestamp: c.candle_date_time_kst,
        }));
    } catch (e) {
        console.error(`Error getCandlesPaginated for ${market}:`, e.message);
        return [];
    }
}

async function getCurrentPrice(market) {
    try {
        const res = await axios.get(`${server_url}/v1/ticker?markets=${market}`);
        return res.data[0].trade_price;
    } catch (e) {
        console.error(`Error getCurrentPrice for ${market}:`, e.message);
        return 0;
    }
}

async function buyMarketOrder(market, amountKrw) {
    try {
        const body = { market, side: 'bid', price: amountKrw.toString(), ord_type: 'price' };
        const res = await axios.post(`${server_url}/v1/orders`, body, { headers: getHeaders(body) });
        console.log(`[BUY] ${market} order success:`, res.data);
        return res.data;
    } catch (e) {
        console.error(`[BUY] ${market} order failed:`, e.response?.data || e.message);
        return null;
    }
}

async function sellMarketOrder(market, volume) {
    try {
        const body = { market, side: 'ask', volume: volume.toString(), ord_type: 'market' };
        const res = await axios.post(`${server_url}/v1/orders`, body, { headers: getHeaders(body) });
        console.log(`[SELL] ${market} order success:`, res.data);
        return res.data;
    } catch (e) {
        console.error(`[SELL] ${market} order failed:`, e.response?.data || e.message);
        return null;
    }
}

async function getRecentOrders(limit = 10) {
    try {
        const queryStr = `state=done&limit=${limit}`;
        const hash = crypto.createHash('sha512').update(queryStr).digest('hex');
        const payload = {
            access_key,
            nonce: uuid.v4(),
            query_hash: hash,
            query_hash_alg: 'SHA512',
        };
        const token = jwt.sign(payload, secret_key);
        const res = await axios.get(`${server_url}/v1/orders?${queryStr}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return res.data;
    } catch (e) {
        console.error('Error getRecentOrders:', e.response?.data || e.message);
        return [];
    }
}

/**
 * Get orderbook (bid-ask spread) for a market.
 * Returns { bidPrice, askPrice, spreadPct, bidSize, askSize }
 */
async function getOrderbook(market) {
    try {
        const res = await axios.get(`${server_url}/v1/orderbook?markets=${market}`);
        const data = res.data[0];
        if (!data || !data.orderbook_units || data.orderbook_units.length === 0) return null;

        const top = data.orderbook_units[0];
        const bidPrice = top.bid_price;
        const askPrice = top.ask_price;
        const spreadPct = +((askPrice - bidPrice) / bidPrice * 100).toFixed(4);

        return {
            bidPrice,
            askPrice,
            spreadPct,
            bidSize: top.bid_size,
            askSize: top.ask_size,
            totalBidSize: data.total_bid_size,
            totalAskSize: data.total_ask_size,
        };
    } catch (e) {
        console.error(`Error getOrderbook for ${market}:`, e.message);
        return null;
    }
}

/**
 * Get ticker data for markets (24h stats, trade intensity).
 * Returns { tradeVolume, tradeValue, prevClosingPrice, change, changeRate, signedChangeRate }
 */
async function getTicker(markets) {
    try {
        const marketStr = Array.isArray(markets) ? markets.join(',') : markets;
        const res = await axios.get(`${server_url}/v1/ticker?markets=${marketStr}`);
        const result = {};
        for (const t of res.data) {
            result[t.market] = {
                tradePrice: t.trade_price,
                prevClosingPrice: t.prev_closing_price,
                change: t.change, // RISE, EVEN, FALL
                signedChangeRate: t.signed_change_rate,
                accTradePrice24h: t.acc_trade_price_24h,
                accTradeVolume24h: t.acc_trade_volume_24h,
                highest52WeekPrice: t.highest_52_week_price,
                lowest52WeekPrice: t.lowest_52_week_price,
            };
        }
        return result;
    } catch (e) {
        console.error('Error getTicker:', e.message);
        return {};
    }
}

module.exports = {
    getBalance,
    getBalances,
    getCandles,
    getCandlesPaginated,
    getCurrentPrice,
    buyMarketOrder,
    sellMarketOrder,
    getRecentOrders,
    getOrderbook,
    getTicker,
};
