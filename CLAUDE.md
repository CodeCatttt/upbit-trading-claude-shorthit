# upbit-trading-claude

Upbit 멀티에셋 트레이딩 봇 with Claude-powered batch strategy analysis.

## Architecture

- **Bot** (`src/bot.js`): PM2 process running 24/7, checks every 15 minutes
- **Strategy** (`src/strategies/current-strategy.js`): Hot-swappable strategy file
- **Batch** (`src/batch/run-batch.sh`): 1-hour cron — collects metrics → calls Claude → backtests → deploys
- **Config** (`trading-config.json`): Dynamic market list, updated by Claude at each batch

## Strategy Interface (Multi-Asset)

All strategies must export:
```javascript
module.exports = {
  DEFAULT_CONFIG,                      // Object with strategy parameters
  createStrategyState(),               // Returns { assetHeld: 'KRW-BTC' }
  onNewCandle(state, candlesByMarket, config?)
    // candlesByMarket: { 'KRW-BTC': [...], 'KRW-ETH': [...], ... }
    // Returns:
    //   { action: 'HOLD', details: { ... } }
    //   { action: 'NONE', details: { reason: '...' } }
    //   { action: 'SWITCH', details: { targetMarket: 'KRW-SOL', reason: '...', ... } }
};
```

### State Format
- `state.assetHeld`: Market code (`'KRW-BTC'`, `'KRW-ETH'`, `'CASH'` etc.)
- Candle format: `{ open, high, low, close, volume, timestamp }`

### Action Types
- `SWITCH`: Sell current asset, buy `details.targetMarket`
- `HOLD`: Keep current position
- `NONE`: No action (insufficient data)

## Strategy Goals & Constraints

### Objectives
- 연 수익률 목표: 시장 평균(BTC buy-and-hold) 대비 초과 수익
- 리스크 관리: 최대 낙폭(MDD) 15% 이내 유지
- 한 번에 하나의 자산만 100% 보유 (현행 유지)

### Asset Selection Criteria
- Upbit KRW 마켓에서 거래 가능한 종목만 대상
- 시가총액 상위 100위 이내 종목만 거래
- 24시간 거래량 일정 수준 이상 (유동성 확보)
- `trading-config.json`의 markets 배열로 관리

### Prohibited Patterns
- 일일 10회 이상 거래 금지 (백테스트 게이트: 6회/일)
- 시가총액 100위 밖 종목 거래 금지
- 레버리지/마진 거래 불가 (Upbit 현물만)
- 단일 배치에서 전략 교체 + 종목 변경 동시 수행 자제

### Backtest & Safety Gates
- 백테스트에 슬리피지 0.1% + 수수료 0.05% 포함 (per side)
- 신규 전략 배포 조건: 수익률 +0.5% 이상 개선, MDD 2% 이내 악화, 일일 거래 6회 이하
- PM2 헬스체크 + 자동 롤백

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.js` | Main bot (PM2 24/7, multi-asset) |
| `src/upbit-api.js` | Upbit API wrapper |
| `src/indicators.js` | Technical indicators library |
| `src/strategies/current-strategy.js` | Active strategy (replaced on deploy) |
| `src/batch/run-batch.sh` | Batch pipeline orchestrator |
| `src/batch/backtest.js` | Multi-asset backtest engine with slippage |
| `src/batch/collect-metrics.js` | Enhanced metrics (Sharpe, win rate, rolling returns) |
| `src/batch/build-prompt.js` | Multi-asset prompt assembly |
| `src/batch/deploy.js` | Safe deploy with rollback |
| `trading-config.json` | Dynamic market list + intervals |
| `bot-state.json` | Bot state (assetHeld as market code) |
| `deploy-log.json` | Deploy history |

## Batch Response Format

```json
{
  "action": "keep" | "modify" | "replace",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"]
}
```

## Safety

- Backtest gate: +0.5% return, MDD ≤ 2% worse, ≤ 6 trades/day
- Slippage model: 0.1% per trade (market order assumption)
- Syntax + interface validation before deploy
- Auto-rollback on PM2 crash after deploy
- Atomic state file writes (crash-safe)
- Market removal safety: 보유 종목은 자동으로 관심 리스트에 유지
