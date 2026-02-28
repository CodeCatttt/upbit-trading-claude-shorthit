/**
 * discord.js
 * Send notifications to Discord channel via bot token.
 */

'use strict';

const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const API_BASE = 'https://discord.com/api/v10';

async function sendMessage(content) {
    if (!BOT_TOKEN || !CHANNEL_ID) {
        console.error('[DISCORD] Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID in .env');
        return null;
    }
    try {
        const res = await axios.post(
            `${API_BASE}/channels/${CHANNEL_ID}/messages`,
            { content },
            { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return res.data;
    } catch (e) {
        console.error('[DISCORD] Send failed:', e.response?.data || e.message);
        return null;
    }
}

async function sendEmbed({ title, description, color = 0x3498db, fields = [] }) {
    if (!BOT_TOKEN || !CHANNEL_ID) {
        console.error('[DISCORD] Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID in .env');
        return null;
    }
    try {
        const res = await axios.post(
            `${API_BASE}/channels/${CHANNEL_ID}/messages`,
            {
                embeds: [{
                    title,
                    description,
                    color,
                    fields,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'upbit-trading-claude' },
                }],
            },
            { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return res.data;
    } catch (e) {
        console.error('[DISCORD] Embed send failed:', e.response?.data || e.message);
        return null;
    }
}

module.exports = { sendMessage, sendEmbed };
