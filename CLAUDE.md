# upbit-trading-claude

Upbit 멀티에셋 트레이딩 봇 with Claude-powered batch strategy analysis.

## Architecture

- **Bot** (`src/bot.js`): PM2 process running 24/7, checks every 15 minutes
- **Execution** (`src/execution/smart-entry.js`): Smart entry module — monitors short-term price for optimal buy timing
- **Strategy** (`src/strategies/current-strategy.js`): Hot-swappable strategy file
- **Custom Indicators** (`src/strategies/custom-indicators.js`): Claude-managed custom indicator functions
- **Batch** (`src/batch/run-batch.sh`): 1-hour cron — collects metrics → calls Claude → backtests → deploys
- **Batch Memory** (`data/batch-memory.json`): Decision history for cross-batch learning
- **Config** (`trading-config.json`): Dynamic market list, updated by Claude at each batch

## Strategy Interface (Multi-Timeframe)

All strategies must export:
```javascript
module.exports = {
  DEFAULT_CONFIG,                      // Object with strategy parameters
  createStrategyState(),               // Returns { assetHeld: 'KRW-BTC' }
  onNewCandle(state, candleData, config?)
    // candleData: {
    //   'KRW-BTC': { 15: [candle, ...], 240: [candle, ...] },
    //   'KRW-ETH': { 15: [candle, ...], 240: [candle, ...] },
    // }
    // Access: candleData['KRW-BTC'][15]  — 15m candles
    //         candleData['KRW-BTC'][240] — 4h candles
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

### Available Imports
- `require('../indicators')` — built-in technical indicators (EMA, RSI, ATR, Kalman, etc.)
- `require('./custom-indicators')` — Claude-managed custom indicator functions
- `require('../utils/adf-test')` — ADF stationarity test

## Candle Data
- Max candles stored: **10000** per market per interval (~104 days for 15m)
- Intervals: 15m (primary), 240m (4h higher-timeframe context)
- Backtest runs on 15m candles; 240m aligned by timestamp at each step

## Batch Memory
- File: `data/batch-memory.json`
- Stores last 50 batch decisions with action, reasoning, outcome, notes
- `strategicNotes`: accumulated strategic insights (Claude replaces each time)
- Helper: `src/batch/update-memory.js` — auto-called by run-batch.sh after each decision

## Custom Indicators
- File: `src/strategies/custom-indicators.js`
- Claude can define new indicator functions via ```custom-indicators code block
- Backed up alongside strategy on deploy; rolled back together on failure
- Strategy uses via `require('./custom-indicators')`

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
- 백테스트에 슬리피지 0.1% (smart 모드 0.05%) + 수수료 0.05% 포함 (per side)
- 신규 전략 배포 조건: 수익률 +0.5% 이상 개선, MDD 2% 이내 악화, 일일 거래 6회 이하
- PM2 헬스체크 + 자동 롤백

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.js` | Main bot (PM2 24/7, multi-timeframe) |
| `src/execution/smart-entry.js` | Smart entry module (RSI dip, pullback, Bollinger) |
| `src/upbit-api.js` | Upbit API wrapper |
| `src/indicators.js` | Technical indicators library |
| `src/strategies/current-strategy.js` | Active strategy (replaced on deploy) |
| `src/strategies/custom-indicators.js` | Custom indicator functions (Claude-managed) |
| `src/batch/run-batch.sh` | Batch pipeline orchestrator |
| `src/batch/backtest.js` | Multi-timeframe backtest engine with slippage |
| `src/batch/collect-metrics.js` | Enhanced metrics (Sharpe, win rate, rolling returns) |
| `src/batch/build-prompt.js` | Multi-timeframe prompt assembly |
| `src/batch/deploy.js` | Safe deploy with rollback (strategy + custom indicators) |
| `src/batch/update-memory.js` | Batch memory append helper |
| `src/batch/parse-response.js` | Response parsing + custom-indicators extraction |
| `trading-config.json` | Dynamic market list + intervals |
| `data/batch-memory.json` | Batch decision history (max 50 entries) |
| `bot-state.json` | Bot state (assetHeld as market code) |
| `deploy-log.json` | Deploy history |
| `data/execution-log.json` | Execution log (smart entry results, max 100) |

## Execution Modes

DEFAULT_CONFIG에 실행 설정 포함:
```javascript
executionMode: 'market',    // 'market' | 'smart' (배치가 전환 가능)
smartEntry: {
    candleInterval: 5,      // 5분 캔들 모니터링
    maxWaitMinutes: 15,     // 최대 대기시간 (초과 시 시장가)
    pollIntervalMs: 15000,  // 폴링 간격
    entryMethod: 'rsi_dip', // 'rsi_dip' | 'pullback' | 'bollinger_touch'
    rsiThreshold: 40,       // RSI 진입 임계값
    pullbackPct: 0.3,       // 풀백 진입 %
},
```

- `market`: 즉시 시장가 주문 (기본값)
- `smart`: 매도 즉시 → 매수는 단기 모니터링 후 유리한 타이밍에 진입
- 실행 로그: `data/execution-log.json` (최대 100건)

## Batch Response Format

```json
{
  "action": "keep" | "modify" | "replace",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
  "improvementAreas": ["strategy", "execution", "risk", "assets", "regime"],
  "notes": "다음 배치를 위한 메모 (선택사항)",
  "strategicNotes": "전략적 인사이트 누적 (선택사항)"
}
```

For "replace" action, additional code blocks:
- ```javascript — complete new strategy file
- ```custom-indicators — custom indicator functions (optional)

## Safety

- Backtest gate: +0.5% return, MDD ≤ 2% worse, ≤ 6 trades/day
- Slippage model: 0.1% per trade (market mode), 0.05% (smart mode)
- Syntax + interface validation before deploy (strategy + custom indicators)
- Auto-rollback on PM2 crash after deploy (strategy + custom indicators)
- Atomic state file writes (crash-safe)
- Market removal safety: 보유 종목은 자동으로 관심 리스트에 유지
- Batch memory: 최근 50개 결정 기록으로 학습 패턴 추적
