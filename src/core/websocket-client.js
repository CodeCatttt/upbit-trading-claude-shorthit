/**
 * websocket-client.js
 * Upbit WebSocket client for real-time price, orderbook, and trade data.
 * Uses native Node.js WebSocket (requires Node 22+) or ws fallback.
 */

'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('../utils/logger');

const log = createLogger('WS');

const UPBIT_WS_URL = 'wss://api.upbit.com/websocket/v1';
const PING_INTERVAL = 30000;
const RECONNECT_DELAY_BASE = 1000;
const RECONNECT_DELAY_MAX = 30000;

class UpbitWebSocket extends EventEmitter {
    constructor(markets = []) {
        super();
        this.markets = markets;
        this.ws = null;
        this.pingTimer = null;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.isClosed = false;

        // Latest data cache
        this.prices = {};        // market -> price
        this.orderbooks = {};    // market -> { bidPrice, askPrice, ... }
        this.trades = {};        // market -> last trade
    }

    async connect() {
        if (this.isConnecting || this.isClosed) return;
        this.isConnecting = true;

        try {
            const WebSocket = await this._getWebSocket();
            this.ws = new WebSocket(UPBIT_WS_URL);

            // Handle binary messages (Upbit sends binary)
            if (this.ws.binaryType !== undefined) {
                this.ws.binaryType = 'arraybuffer';
            }

            this.ws.onopen = () => {
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                log.info(`Connected to Upbit WebSocket, markets: ${this.markets.join(', ')}`);
                this._subscribe();
                this._startPing();
                this.emit('connected');
            };

            this.ws.onmessage = (event) => {
                try {
                    const raw = event.data instanceof ArrayBuffer
                        ? Buffer.from(event.data).toString('utf-8')
                        : typeof event.data === 'string'
                            ? event.data
                            : event.data.toString('utf-8');
                    const data = JSON.parse(raw);
                    this._handleMessage(data);
                } catch (e) {
                    log.error('WS message parse error:', e.message);
                }
            };

            this.ws.onerror = (err) => {
                log.error('WS error:', err.message || 'unknown');
                this.isConnecting = false;
            };

            this.ws.onclose = () => {
                log.warn('WS connection closed');
                this.isConnecting = false;
                this._stopPing();
                if (!this.isClosed) {
                    this._reconnect();
                }
            };
        } catch (e) {
            log.error('WS connect error:', e.message);
            this.isConnecting = false;
            if (!this.isClosed) {
                this._reconnect();
            }
        }
    }

    async _getWebSocket() {
        // Try native WebSocket (Node 22+), fallback to 'ws' package
        if (typeof globalThis.WebSocket !== 'undefined') {
            return globalThis.WebSocket;
        }
        try {
            return require('ws');
        } catch (e) {
            throw new Error('WebSocket not available. Install ws package: npm install ws');
        }
    }

    _subscribe() {
        if (!this.ws || this.ws.readyState !== 1) return;

        const payload = [
            { ticket: `day-trading-${Date.now()}` },
            {
                type: 'ticker',
                codes: this.markets,
                isOnlyRealtime: true,
            },
            {
                type: 'trade',
                codes: this.markets,
                isOnlyRealtime: true,
            },
            {
                type: 'orderbook',
                codes: this.markets,
                isOnlyRealtime: true,
            },
        ];

        this.ws.send(JSON.stringify(payload));
        log.info('Subscribed to ticker, trade, orderbook');
    }

    _handleMessage(data) {
        if (!data || !data.type) return;

        const market = data.code;

        if (data.type === 'ticker') {
            this.prices[market] = data.trade_price;
            this.emit('ticker', {
                market,
                price: data.trade_price,
                change: data.signed_change_rate,
                volume24h: data.acc_trade_volume_24h,
                high: data.high_price,
                low: data.low_price,
                timestamp: data.trade_timestamp,
            });
        } else if (data.type === 'trade') {
            this.trades[market] = {
                price: data.trade_price,
                volume: data.trade_volume,
                side: data.ask_bid, // ASK=sell, BID=buy
                timestamp: data.trade_timestamp,
            };
            this.emit('trade', {
                market,
                price: data.trade_price,
                volume: data.trade_volume,
                side: data.ask_bid,
                timestamp: data.trade_timestamp,
            });
        } else if (data.type === 'orderbook') {
            const units = data.orderbook_units;
            if (units && units.length > 0) {
                const top = units[0];
                this.orderbooks[market] = {
                    bidPrice: top.bid_price,
                    askPrice: top.ask_price,
                    bidSize: top.bid_size,
                    askSize: top.ask_size,
                    totalBidSize: data.total_bid_size,
                    totalAskSize: data.total_ask_size,
                    spreadPct: +((top.ask_price - top.bid_price) / top.bid_price * 100).toFixed(4),
                    timestamp: data.timestamp,
                };
                this.emit('orderbook', { market, ...this.orderbooks[market] });
            }
        }
    }

    _startPing() {
        this._stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                this.ws.send('PING');
            }
        }, PING_INTERVAL);
    }

    _stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    _reconnect() {
        if (this.isClosed) return;
        this.reconnectAttempts++;
        const delay = Math.min(
            RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectAttempts - 1),
            RECONNECT_DELAY_MAX
        );
        log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    getPrice(market) {
        return this.prices[market] || 0;
    }

    getOrderbook(market) {
        return this.orderbooks[market] || null;
    }

    updateMarkets(markets) {
        this.markets = markets;
        this._subscribe();
    }

    close() {
        this.isClosed = true;
        this._stopPing();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.removeAllListeners();
    }
}

module.exports = { UpbitWebSocket };
