# upbit-trading-claude

Upbit 멀티에셋 트레이딩 봇 with Claude-powered batch strategy analysis.

## Architecture

- **Bot** (`src/bot.js`): PM2 process running 24/7, checks every 15 minutes
- **Execution** (`src/execution/smart-entry.js`): Smart entry module — monitors short-term price for optimal buy timing
- **Strategy** (`src/strategies/current-strategy.js`): Hot-swappable strategy file
- **Custom Indicators** (`src/strategies/custom-indicators.js`): Claude-managed custom indicator functions
- **Batch Scheduler** (`src/batch/batch-scheduler.js`): PM2 process — trigger-based adaptive batch scheduling (replaces fixed cron)
- **Batch** (`src/batch/run-batch.sh`): Pipeline orchestrator — collects metrics → calls Claude → backtests → deploys (retry loop + multi-variant)
- **Batch Memory** (`data/batch-memory.json`): Decision history + structured knowledge base for cross-batch learning
- **Performance Tracker** (`src/batch/performance-tracker.js`): Daily real P&L vs BTC benchmark tracking
- **Experiment Manager** (`src/batch/experiment-manager.js`): Structured hypothesis → test → learn cycle
- **Shadow Manager** (`src/batch/shadow-manager.js`): Paper-trading parallel strategy evaluation
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
- `SWITCH` (to CASH): `{ action: 'SWITCH', details: { targetMarket: 'CASH', reason: '...' } }` — sell to KRW, hold as cash
- `SWITCH` (from CASH): Strategy's `checkReentry()` determines when to buy back (RSI + trend + cooldown)
- `HOLD`: Keep current position (or stay in CASH)
- `NONE`: No action (insufficient data)

### Current Strategy: Adaptive Regime Multi-Timeframe
- **15m 캔들**: 빠른 리스크 신호 (crash detection, trailing stop)
- **4h 캔들**: 트렌드 스코어링, 레짐 감지, 스위칭 결정
- **CASH 전환**: trailing stop (12%) + 24h crash detection (8%) → 자동 현금 전환
- **적응형 쿨다운**: 트렌딩 시장 3일, 횡보 시장 14일 (choppiness 기반 보간)
- **스마트 재진입**: RSI > 45 + 양의 스코어 + EMA 골든크로스 확인 후 매수
- **그레이스 기간**: 진입 후 24h 동안 리스크 체크 비활성화 (whipsaw 방지)
- **복합 스코어링**: 모멘텀(45%) + EMA 트렌드(25%) + 거래량(15%) + 볼린저(15%)

### Available Imports
- `require('../indicators')` — built-in technical indicators (EMA, RSI, ATR, Kalman, etc.)
- `require('./custom-indicators')` — Claude-managed custom indicator functions
- `require('../utils/adf-test')` — ADF stationarity test

## Candle Data
- Max candles stored: **10000** per market per interval (~104 days for 15m)
- Intervals: 15m (primary), 240m (4h higher-timeframe context)
- Backtest runs on 15m candles; 240m aligned by timestamp at each step

## Batch Scheduling (Adaptive)

**Trigger-based scheduling** — replaces fixed hourly cron:

| Trigger | Condition | Prompt Mode |
|---------|-----------|-------------|
| REGIME_CHANGE | 24h price change > 5% (any asset) | 전략 교체/수정 집중 |
| DRAWDOWN_ALERT | Portfolio MDD > 8% | 리스크 관리 집중 |
| STAGNATION | 7+ days since last trade | 기회 탐색 집중 |
| DAILY_REVIEW | Daily candle close (UTC 0:00) | 전반적 점검 |
| EXPERIMENT_REVIEW | Active experiment duration met | 실험 결과 평가 |

- Minimum 6h between batches (prevents spam)
- `BATCH_TRIGGER` env var passed to `build-prompt.js` for focused prompts
- PM2 process: `batch-scheduler` (checks every 15 minutes)

## Batch Memory & Knowledge Base
- File: `data/batch-memory.json`
- Stores last 50 batch decisions with action, reasoning, outcome, notes
- **Structured Knowledge** (replaces flat strategicNotes):
  - `knowledge.confirmed`: 백테스트+실거래로 검증된 사실 (max 20)
  - `knowledge.hypotheses`: 검증 대기 중인 가설 (max 20)
  - `knowledge.rejected`: 실험으로 반증된 가설 (max 20)
- Helper: `src/batch/update-memory.js` — auto-called by run-batch.sh

## Performance Tracking
- File: `data/performance-ledger.json`
- Daily recording: portfolio value, BTC benchmark, alpha, MDD
- Tracked automatically during `collect-metrics.js`
- Summary (totalReturn, btcReturn, alpha, maxMdd, winRate) included in batch prompt

## Experiment Framework
- File: `data/experiments.json`
- Lifecycle: propose → backtest → deploy/reject → evaluate → learn
- Max 2 active experiments simultaneously
- Types: `parameter_test`, `shadow_strategy`
- Batch response `"action": "experiment"` triggers proposal
- Completed experiments generate knowledge entries (confirmed/rejected)

## Shadow Strategy System
- Directory: `data/shadow-strategies/`
- Performance: `data/shadow-performance.json`
- New strategies run in paper-trading mode alongside live strategy
- Bot executes shadow cycles each 15-minute tick (no real orders)
- 7-day evaluation period before promotion decision

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
- Walk-forward 백테스트: 70/30 분할, TEST 구간 기준 평가 (최소 200캔들, 미만 시 단일패스)
- 티어드 게이트 (완화):
  - `replace`: 수익률 차이 >= -1%, MDD 악화 <= 3%, 일일거래 <= 6
  - `modify`: 수익률 차이 >= -2%, MDD 악화 <= 5%, 일일거래 <= 6
- PM2 헬스체크 + 자동 롤백
- 배포 전 드라이런: 실제 캔들 데이터로 onNewCandle 100회 반복, 런타임 에러 사전 차단

### Batch Self-Improvement
- **재시도 루프**: replace 게이트 실패 시 최대 2회 재시도 (총 3회 시도)
  - 실패 진단 (`diagnose-failure.js`): 수익률/MDD/거래빈도 각 항목 분석 + 개선 제안
  - 재시도 프롬프트 (`build-retry-prompt.js`): 실패 코드 + 진단 + 게이트 기준 → 타겟 수정 지시
- **멀티변형**: replace 시 최대 3개 전략 변형 제출, 모두 독립 백테스트 → 게이트 통과 중 최고 성과 선택
  - 각 ```javascript 블록 첫줄에 `// VARIANT: 라벨` 작성
- **배치 메모리 강화**: 실패 시 retryAttempts, variantsTested, diagnosis 기록 → 다음 배치 학습

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.js` | Main bot (PM2 24/7, multi-timeframe + shadow execution) |
| `src/execution/smart-entry.js` | Smart entry module (RSI dip, pullback, Bollinger) |
| `src/upbit-api.js` | Upbit API wrapper (+ orderbook, ticker) |
| `src/indicators.js` | Technical indicators library |
| `src/strategies/current-strategy.js` | Active strategy (replaced on deploy) |
| `src/strategies/custom-indicators.js` | Custom indicator functions (Claude-managed) |
| `src/batch/batch-scheduler.js` | Adaptive batch scheduler (PM2, trigger-based) |
| `src/batch/run-batch.sh` | Batch pipeline orchestrator (retry + multi-variant + experiment) |
| `src/batch/backtest.js` | Multi-timeframe backtest engine with slippage |
| `src/batch/diagnose-failure.js` | Gate failure diagnosis for retry prompts |
| `src/batch/build-retry-prompt.js` | Focused retry prompt builder |
| `src/batch/collect-metrics.js` | Enhanced metrics (Sharpe, win rate, orderbook, trade intensity) |
| `src/batch/build-prompt.js` | Trigger-based focused prompt assembly |
| `src/batch/deploy.js` | Safe deploy with dry-run + rollback (strategy + custom indicators) |
| `src/batch/update-memory.js` | Batch memory + structured knowledge management |
| `src/batch/parse-response.js` | Response parsing (+ experiment action) |
| `src/batch/performance-tracker.js` | Real P&L vs BTC benchmark daily tracking |
| `src/batch/experiment-manager.js` | Structured experiment lifecycle management |
| `src/batch/shadow-manager.js` | Shadow (paper-trading) strategy parallel execution |
| `trading-config.json` | Dynamic market list + intervals |
| `data/batch-memory.json` | Batch decisions + structured knowledge base |
| `data/performance-ledger.json` | Daily portfolio performance records |
| `data/experiments.json` | Active/completed experiments |
| `data/shadow-strategies/` | Shadow strategy files |
| `data/shadow-performance.json` | Shadow strategy performance tracking |
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
  "action": "keep" | "modify" | "replace" | "experiment",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
  "improvementAreas": ["strategy", "execution", "risk", "assets", "regime"],
  "notes": "다음 배치를 위한 메모 (선택사항)",
  "knowledge": {
    "confirmed": [{"insight": "...", "evidence": "..."}],
    "hypotheses": [{"hypothesis": "...", "status": "proposed"}],
    "rejected": [{"hypothesis": "...", "reason": "..."}]
  },
  "experiment": {
    "hypothesis": "...",
    "design": {"type": "parameter_test", "changes": {}, "duration": "7d", "successCriteria": "..."}
  }
}
```

For "replace" action, additional code blocks:
- ```javascript — complete new strategy file (최대 3개 변형 가능, 첫줄에 `// VARIANT: 라벨`)
- ```custom-indicators — custom indicator functions (optional)

## Safety

- Tiered backtest gates: replace (return diff >= -1%, MDD <= 3% worse), modify (return diff >= -2%, MDD <= 5% worse), both <= 6 trades/day
- Walk-forward: replace uses 70/30 split, TEST period for gate evaluation
- Slippage model: 0.1% per trade (market mode), 0.05% (smart mode)
- Pre-deploy dry-run: 실제 캔들 데이터로 100회 반복 실행하여 런타임 에러 사전 차단
- Syntax + interface validation before deploy (strategy + custom indicators)
- Auto-rollback on PM2 crash after deploy (strategy + custom indicators)
- Replace retry loop: 게이트 실패 시 최대 2회 자동 재시도 (진단 기반 타겟 수정)
- Atomic state file writes (crash-safe)
- Market removal safety: 보유 종목은 자동으로 관심 리스트에 유지
- Batch memory: 최근 50개 결정 기록 + 구조화된 학습 지식 추적
- Shadow strategies: 새 전략을 7일간 페이퍼 트레이딩 후 승격/폐기 결정
- Adaptive scheduling: 트리거 기반 배치 실행, 최소 6시간 간격 보장
