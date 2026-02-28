# upbit-trading-claude

Upbit BTC/ETH relative value trading bot with Claude-powered batch strategy analysis.

## Architecture

- **Bot** (`src/bot.js`): PM2 process running 24/7, checks every 15 minutes
- **Strategy** (`src/strategies/current-strategy.js`): Hot-swappable strategy file
- **Batch** (`src/batch/run-batch.sh`): 6-hour cron — collects metrics → calls Claude → backtests → deploys

## Strategy Interface

All strategies must export:
```javascript
module.exports = {
  DEFAULT_CONFIG,           // Object with strategy parameters
  createStrategyState(),    // Returns { assetHeld: 'IN_BTC' }
  onNewCandle(state, btcCandles, ethCandles, config?)
    // Returns { action: 'SWITCH_TO_BTC'|'SWITCH_TO_ETH'|'HOLD'|'NONE', details: {} }
};
```

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.js` | Main bot (PM2 24/7) |
| `src/upbit-api.js` | Upbit API wrapper |
| `src/indicators.js` | Technical indicators library |
| `src/strategies/current-strategy.js` | Active strategy (replaced on deploy) |
| `src/batch/run-batch.sh` | Batch pipeline orchestrator |
| `src/batch/backtest.js` | Backtest engine |
| `src/batch/deploy.js` | Safe deploy with rollback |
| `bot-state.json` | Bot state (assetHeld) |
| `deploy-log.json` | Deploy history |

## Safety

- 12-hour cooldown between deploys
- Backtest gate: new strategy must beat current by 0.5% return, max drawdown <= 2% worse
- Syntax + interface validation before deploy
- Auto-rollback on PM2 crash after deploy
- Max 4 trades/day limit
