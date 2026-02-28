/**
 * build-prompt.js
 * Assembles the Claude analysis prompt from collected metrics.
 * Reads the latest metrics file and current strategy, outputs prompt to stdout.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('BUILD-PROMPT');

const METRICS_DIR = path.join(__dirname, '../../data/metrics');
const DEPLOY_LOG = path.join(__dirname, '../../deploy-log.json');
const INDICATORS_FILE = path.join(__dirname, '../indicators.js');
const BACKTEST_DIR = path.join(__dirname, '../../data/backtest-results');

function getLatestMetrics() {
    if (!fs.existsSync(METRICS_DIR)) return null;
    const files = fs.readdirSync(METRICS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(METRICS_DIR, files[files.length - 1]), 'utf8'));
}

function buildPrompt() {
    const metrics = getLatestMetrics();
    if (!metrics) {
        log.error('No metrics file found.');
        process.exit(1);
    }

    const deployLog = fs.existsSync(DEPLOY_LOG)
        ? JSON.parse(fs.readFileSync(DEPLOY_LOG, 'utf8'))
        : [];

    const indicatorsSource = fs.readFileSync(INDICATORS_FILE, 'utf8');

    // Extract available indicator function names
    const indicatorExports = indicatorsSource.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    const availableIndicators = indicatorExports
        ? indicatorExports[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];

    const prompt = `You are a quantitative trading strategy analyst for a BTC/ETH relative value bot on Upbit (Korean exchange).

## Current Portfolio
- Total Value: ${metrics.portfolio.totalValueKrw.toLocaleString()} KRW
- Holdings: ${JSON.stringify(metrics.portfolio.holdings, null, 2)}

## Market Data
- BTC Price: ${metrics.market.btcPrice?.toLocaleString()} KRW
- ETH Price: ${metrics.market.ethPrice?.toLocaleString()} KRW
- BTC/ETH Ratio: ${metrics.market.btcEthRatio?.toFixed(4)}

## Bot Status
- Current State: ${JSON.stringify(metrics.bot.state)}
- Healthy: ${metrics.bot.healthy}
- Heartbeat Age: ${metrics.bot.heartbeatAgeSec}s

## Recent Trades
${JSON.stringify(metrics.recentOrders, null, 2)}

## Current Strategy Source Code
\`\`\`javascript
${metrics.strategy.source}
\`\`\`

## Available Indicators (from indicators.js)
${availableIndicators.join(', ')}

Full indicator module source for reference:
\`\`\`javascript
${indicatorsSource}
\`\`\`

## Recent Deploy History (last 5)
${JSON.stringify(deployLog.slice(-5), null, 2)}

## Recent Backtest Results (last 3)
${(() => {
    if (!fs.existsSync(BACKTEST_DIR)) return 'No backtest results yet.';
    const files = fs.readdirSync(BACKTEST_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return 'No backtest results yet.';
    return files.slice(-3).map(f => {
        try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR, f), 'utf8')), null, 2); }
        catch { return ''; }
    }).filter(Boolean).join('\n---\n');
})()}

## Your Task
Analyze the current strategy's performance and market conditions. Choose ONE action:

1. **KEEP** - Current strategy is performing well, no changes needed.
2. **MODIFY** - Adjust parameters (thresholds, lookback, etc.) of the current strategy.
3. **REPLACE** - Write a completely new strategy file.

## Constraints
- The strategy must export: \`DEFAULT_CONFIG\`, \`createStrategyState()\`, \`onNewCandle(state, btcCandles, ethCandles, config?)\`
- \`onNewCandle\` must return: \`{ action: 'SWITCH_TO_BTC'|'SWITCH_TO_ETH'|'HOLD'|'NONE', details: {} }\`
- \`createStrategyState()\` must return \`{ assetHeld: 'IN_BTC' }\`
- You may use any function from indicators.js via \`require('../indicators')\`
- You may use \`require('../utils/adf-test')\` for the ADF test
- Do NOT use any external npm packages beyond what the project already has
- The strategy runs on 15-minute candles; btcCandles and ethCandles are arrays of {open, high, low, close, volume, timestamp}
- Daily trade frequency should stay under 4 trades/day

## Response Format
First, provide your analysis and reasoning in plain text.

Then output your decision as a JSON block:

\`\`\`json
{
  "action": "keep" | "modify" | "replace",
  "reasoning": "Brief explanation",
  "confidence": 0.0 to 1.0,
  "parameters": {} // only for "modify" action
}
\`\`\`

If action is "replace", also output the complete new strategy file:

\`\`\`javascript
// Complete strategy file here
\`\`\`
`;

    return prompt;
}

if (require.main === module) {
    const prompt = buildPrompt();
    process.stdout.write(prompt);
}

module.exports = { buildPrompt };
