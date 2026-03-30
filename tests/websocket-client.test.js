/**
 * Tests for WebSocket client.
 * Tests the internal state management without connecting to real Upbit.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { UpbitWebSocket } = require('../src/core/websocket-client');

describe('UpbitWebSocket', () => {
    describe('constructor', () => {
        it('should initialize with markets', () => {
            const ws = new UpbitWebSocket(['KRW-BTC', 'KRW-ETH']);
            assert.deepStrictEqual(ws.markets, ['KRW-BTC', 'KRW-ETH']);
            assert.deepStrictEqual(ws.prices, {});
            assert.deepStrictEqual(ws.orderbooks, {});
        });
    });

    describe('_handleMessage', () => {
        it('should handle ticker messages', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            let emitted = null;
            ws.on('ticker', (data) => { emitted = data; });

            ws._handleMessage({
                type: 'ticker',
                code: 'KRW-BTC',
                trade_price: 95000000,
                signed_change_rate: 0.02,
                acc_trade_volume_24h: 1234,
                high_price: 96000000,
                low_price: 94000000,
                trade_timestamp: Date.now(),
            });

            assert.equal(ws.prices['KRW-BTC'], 95000000);
            assert.ok(emitted);
            assert.equal(emitted.market, 'KRW-BTC');
            assert.equal(emitted.price, 95000000);
        });

        it('should handle trade messages', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            let emitted = null;
            ws.on('trade', (data) => { emitted = data; });

            ws._handleMessage({
                type: 'trade',
                code: 'KRW-BTC',
                trade_price: 95000000,
                trade_volume: 0.5,
                ask_bid: 'BID',
                trade_timestamp: Date.now(),
            });

            assert.ok(ws.trades['KRW-BTC']);
            assert.equal(ws.trades['KRW-BTC'].price, 95000000);
            assert.ok(emitted);
            assert.equal(emitted.side, 'BID');
        });

        it('should handle orderbook messages', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            let emitted = null;
            ws.on('orderbook', (data) => { emitted = data; });

            ws._handleMessage({
                type: 'orderbook',
                code: 'KRW-BTC',
                orderbook_units: [{
                    bid_price: 94990000,
                    ask_price: 95010000,
                    bid_size: 1.5,
                    ask_size: 2.0,
                }],
                total_bid_size: 100,
                total_ask_size: 120,
                timestamp: Date.now(),
            });

            const ob = ws.orderbooks['KRW-BTC'];
            assert.ok(ob);
            assert.equal(ob.bidPrice, 94990000);
            assert.equal(ob.askPrice, 95010000);
            assert.ok(ob.spreadPct > 0);
            assert.ok(emitted);
        });

        it('should ignore messages without type', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws._handleMessage({});
            ws._handleMessage(null);
            assert.deepStrictEqual(ws.prices, {});
        });

        it('should ignore orderbook messages without units', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws._handleMessage({
                type: 'orderbook',
                code: 'KRW-BTC',
                orderbook_units: [],
            });
            assert.deepStrictEqual(ws.orderbooks, {});
        });
    });

    describe('getPrice', () => {
        it('should return cached price', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws.prices['KRW-BTC'] = 95000000;
            assert.equal(ws.getPrice('KRW-BTC'), 95000000);
        });

        it('should return 0 for unknown market', () => {
            const ws = new UpbitWebSocket([]);
            assert.equal(ws.getPrice('KRW-BTC'), 0);
        });
    });

    describe('getOrderbook', () => {
        it('should return cached orderbook', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws.orderbooks['KRW-BTC'] = { bidPrice: 100, askPrice: 101 };
            assert.deepStrictEqual(ws.getOrderbook('KRW-BTC'), { bidPrice: 100, askPrice: 101 });
        });

        it('should return null for unknown market', () => {
            const ws = new UpbitWebSocket([]);
            assert.equal(ws.getOrderbook('KRW-BTC'), null);
        });
    });

    describe('updateMarkets', () => {
        it('should update markets list', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws.updateMarkets(['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);
            assert.deepStrictEqual(ws.markets, ['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);
        });
    });

    describe('close', () => {
        it('should mark as closed and clean up', () => {
            const ws = new UpbitWebSocket(['KRW-BTC']);
            ws.close();
            assert.equal(ws.isClosed, true);
            assert.equal(ws.ws, null);
        });
    });
});
