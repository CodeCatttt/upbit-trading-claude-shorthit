/**
 * logger.js
 * Structured logging: [ISO_TIMESTAMP] [LEVEL] [COMPONENT] message {data}
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatMsg(level, component, message, data) {
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] [${component}] ${message}`;
    if (data !== undefined) {
        line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
    }
    return line;
}

function createLogger(component, logFile = null) {
    let stream = null;
    if (logFile) {
        const fullPath = path.join(LOG_DIR, logFile);
        ensureDir(path.dirname(fullPath));
        stream = fs.createWriteStream(fullPath, { flags: 'a' });
    }

    function log(level, message, data) {
        const line = formatMsg(level, component, message, data);
        console.log(line);
        if (stream) {
            stream.write(line + '\n');
        }
    }

    return {
        info: (msg, data) => log('INFO', msg, data),
        warn: (msg, data) => log('WARN', msg, data),
        error: (msg, data) => log('ERROR', msg, data),
        debug: (msg, data) => log('DEBUG', msg, data),
        close: () => { if (stream) stream.end(); },
    };
}

module.exports = { createLogger };
