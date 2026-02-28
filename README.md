# upbit-trading-claude

업비트(Upbit) 거래소에서 멀티에셋 전략으로 자동매매하는 봇입니다.
1시간마다 Claude CLI(Opus)가 시장 데이터와 전략 성과를 분석하여, 전략과 관심 종목을 자율적으로 개선합니다.

## 핵심 아이디어

- **단일 자산 100% 보유**: 한 번에 하나의 자산만 보유하고, 가장 유망한 종목으로 전환
- **동적 종목 선정**: Claude가 매 배치마다 관심 종목 리스트를 동적으로 결정
- **자율 전략 개선**: 백테스트 게이트를 통과해야만 새 전략 배포 (슬리피지 + 수수료 포함)
- **안전장치**: 구문/인터페이스 검증, 백테스트 비교, PM2 헬스체크, 자동 롤백

## 아키텍처

```
┌──────────────────────────────────────────────────────────┐
│                   Cron (1시간마다)                          │
│                   run-batch.sh                            │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
│  │  캔들    │→│  메트릭  │→│  Claude   │→│  파서    │ │
│  │  수집    │  │  수집    │  │  CLI 호출 │  │  검증    │ │
│  │ (4종목+) │  │(Sharpe등)│  │ (Opus)   │  │(종목갱신)│ │
│  └──────────┘  └──────────┘  └───────────┘  └────┬─────┘ │
│                                                   │       │
│                              ┌───────────┐  ┌─────▼─────┐ │
│                              │  배포     │←│ 백테스트  │ │
│                              │  +롤백    │  │ +슬리피지 │ │
│                              └─────┬─────┘  └───────────┘ │
│                                    │                       │
│                              ┌─────▼─────┐                │
│                              │ git commit │                │
│                              │  & push    │                │
│                              └───────────┘                │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                   PM2 (24/7 상시 실행)                      │
│                       bot.js                              │
│                                                           │
│  15분마다 current-strategy.js 로딩 → onNewCandle 호출      │
│  → SWITCH(targetMarket) / HOLD / NONE 판단                │
│  → Upbit API로 매매 실행 (atomic swap)                     │
└──────────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
upbit-trading-claude/
├── .env                          # Upbit API 키
├── ecosystem.config.js           # PM2 설정
├── trading-config.json           # 동적 종목 + 인터벌 설정
├── bot-state.json                # 봇 상태 (KRW-BTC, KRW-SOL 등)
├── deploy-log.json               # 배포 이력
│
├── src/
│   ├── bot.js                    # 매매 봇 (PM2, 15분 cron, 멀티에셋)
│   ├── upbit-api.js              # Upbit REST API 래퍼
│   ├── indicators.js             # 기술 지표 라이브러리
│   │
│   ├── strategies/
│   │   └── current-strategy.js   # 현재 활성 전략 (배치가 교체)
│   │
│   ├── batch/
│   │   ├── run-batch.sh          # 배치 오케스트레이터
│   │   ├── collect-metrics.js    # 강화 메트릭 (Sharpe, 승률, 롤링 수익률)
│   │   ├── build-prompt.js       # 멀티에셋 Claude 프롬프트 조립
│   │   ├── parse-response.js     # 응답 파싱 + 코드/종목 검증
│   │   ├── backtest.js           # 멀티에셋 백테스트 + 슬리피지 모델
│   │   ├── deploy.js             # 안전 배포 + 자동 롤백
│   │   ├── apply-modify.js       # 파라미터 수정 적용
│   │   └── notify.js             # Discord 알림
│   │
│   ├── data/
│   │   ├── candle-fetcher.js     # 동적 종목 캔들 수집
│   │   └── candle-store.js       # JSON 캔들 저장/병합/중복제거
│   │
│   └── utils/
│       ├── adf-test.js           # Augmented Dickey-Fuller 검정
│       ├── discord.js            # Discord 봇 API
│       └── logger.js             # 구조화된 로깅
│
├── data/
│   ├── candles/                  # 종목별 × 인터벌별 캔들 (각 2000개)
│   ├── metrics/                  # 배치 메트릭 스냅샷
│   └── backtest-results/         # 백테스트 결과
│
├── backups/                      # 전략 백업 (배포 전 자동 생성)
└── logs/
    └── batch/                    # 배치 실행 로그
```

## 설치 및 실행

### 사전 요구사항

- Node.js 18+
- PM2 (`npm install -g pm2`)
- Claude CLI (`claude` 명령어 사용 가능)
- Upbit API 키

### 설치

```bash
git clone git@github.com:CodeCatttt/upbit-trading-claude.git
cd upbit-trading-claude
npm install
```

### 환경 변수 설정

```bash
cat > .env << 'EOF'
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key
DISCORD_BOT_TOKEN=your_discord_bot_token    # 선택사항
DISCORD_CHANNEL_ID=your_channel_id          # 선택사항
EOF
```

### 봇 시작

```bash
# 초기 캔들 데이터 수집 (최초 1회)
node src/data/candle-fetcher.js

# PM2로 봇 시작
pm2 start ecosystem.config.js
pm2 save
```

### 배치 크론 등록

```bash
crontab -e
# 다음 줄 추가 (1시간마다):
30 * * * * /path/to/upbit-trading-claude/src/batch/run-batch.sh >> /path/to/upbit-trading-claude/logs/batch/cron.log 2>&1
```

## 종목 관리

`trading-config.json`으로 관심 종목을 관리합니다. Claude가 배치 분석 시 종목을 추가/제거할 수 있습니다.

```json
{
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP"],
  "defaultAsset": "KRW-BTC",
  "candleIntervals": [15, 240]
}
```

- 현재 보유 중인 종목은 자동으로 리스트에 유지됩니다 (안전장치)
- Upbit KRW 마켓에서 거래 가능한 종목만 대상

## 전략 인터페이스

모든 전략은 다음 인터페이스를 준수해야 합니다:

```javascript
module.exports = {
    DEFAULT_CONFIG,                     // { lookback, switchThreshold, ... }
    createStrategyState(),              // → { assetHeld: 'KRW-BTC', candlesSinceLastTrade: 9999 }
    onNewCandle(state, candlesByMarket, config?)
    // candlesByMarket: { 'KRW-BTC': [...], 'KRW-ETH': [...], ... }
    // 반환값:
    //   { action: 'HOLD', details: { ... } }
    //   { action: 'NONE', details: { reason: '...' } }
    //   { action: 'SWITCH', details: { targetMarket: 'KRW-SOL', reason: '...', ... } }
};
```

### 상태 형식

- `state.assetHeld`: 시장 코드 (`'KRW-BTC'`, `'KRW-SOL'`, `'CASH'` 등)
- `state.candlesSinceLastTrade`: 마지막 거래 이후 캔들 수
- 캔들: `{ open, high, low, close, volume, timestamp }`

### 사용 가능한 기술 지표 (`indicators.js`)

| 함수 | 설명 |
|------|------|
| `calcPriceRatio` | 두 자산의 가격 비율 |
| `estimateOU` | OU 파라미터 추정 (μ, θ, σ) |
| `calculateDynamicThreshold` | σ/θ 기반 동적 임계값 |
| `calcEMA` / `calcEMASeries` | 지수이동평균 |
| `calcRSI` | 상대강도지수 |
| `calcBollingerBands` | 볼린저 밴드 |
| `calcATR` | Average True Range |
| `calcZScore` | Z-score |
| `calcKalmanFilter` | 칼만 필터 |

## 배치 파이프라인

1시간마다 `run-batch.sh`가 순차 실행합니다:

```
Step 0    캔들 수집        동적 종목 × 인터벌 조합 캔들 수집
Step 1    메트릭 수집      잔고, 시세, Sharpe, 승률, 롤링 수익률
Step 2    Claude 호출      멀티에셋 프롬프트 + 종목 관리 지시
Step 3    응답 파싱        JSON 결정 + JS 코드 추출, 인터페이스 검증
Step 3.5  종목 갱신        markets 필드가 있으면 trading-config.json 업데이트
Step 4    백테스트         현재 vs 신규 전략 (슬리피지 0.1% + 수수료 0.05%)
Step 5    배포             백업 → 교체 → PM2 재시작 → 헬스체크 → (실패 시 롤백)
Step 6    git commit/push  변경사항 버전관리
```

### Claude의 3가지 선택지

| 결정 | 설명 | 후속 동작 |
|------|------|-----------|
| **KEEP** | 현재 전략 유지 | 종료 |
| **MODIFY** | 파라미터만 조정 | DEFAULT_CONFIG 값 교체 → git commit |
| **REPLACE** | 전략 전체 교체 | 백테스트 → 배포 → git commit & push |

추가로, 응답 JSON에 `markets` 필드를 포함하면 관심 종목 리스트를 변경할 수 있습니다.

## 강화 메트릭

배치 프롬프트에 포함되는 성과 지표:

| 메트릭 | 설명 |
|--------|------|
| **Sharpe Ratio** | 최근 30일 수익률의 평균/표준편차 |
| **승률** | 배포 후 수익/손실 비율 |
| **롤링 수익률** | 최근 7일, 30일 포트폴리오 변화율 |
| **거래 통계** | 총 배포 수, 평균 보유 시간 |
| **종목별 시세** | 각 관심 종목 현재가, 24h 변동률 |

## 안전장치

| 장치 | 설명 |
|------|------|
| 백테스트 게이트 | 수익률 +0.5% 이상 개선, 낙폭 악화 2% 이내, 일일거래 6회 이하 |
| 슬리피지 모델 | 0.1% 슬리피지 + 0.05% 수수료 (per side) |
| 구문 검증 | `node -c` + `require()` + mock `onNewCandle()` 호출 |
| 인터페이스 검증 | SWITCH/HOLD/NONE 액션, targetMarket 존재 확인 |
| 30초 헬스체크 | 배포 후 PM2 상태 + 재시작 횟수 확인 |
| 자동 롤백 | 헬스체크 실패 시 백업 전략 복원 + PM2 재시작 |
| Atomic SWITCH | 매수 성공 후에만 state 변경, 실패 시 CASH 상태로 전환 |
| Atomic state write | tmp 파일 쓰기 + rename으로 파일 손상 방지 |
| 종목 보호 | 보유 중인 종목은 markets 리스트에서 자동 유지 |
| 감사 추적 | 배치 로그, 배포 로그, 백테스트 결과 모두 보존 |

## 운영 명령어

```bash
# 봇 상태 확인
pm2 list
pm2 logs upbit-trading-bot --lines 20

# 하트비트 확인
cat data/bot-heartbeat.json

# 수동 배치 실행
bash src/batch/run-batch.sh

# 수동 백테스트
node src/batch/backtest.js

# 수동 캔들 수집
node src/data/candle-fetcher.js

# 수동 메트릭 수집
node src/batch/collect-metrics.js

# 크론 확인
crontab -l

# 배포 이력 확인
cat deploy-log.json | jq '.'

# 관심 종목 확인
cat trading-config.json | jq '.'
```

## 기술 스택

- **Runtime**: Node.js
- **Process Manager**: PM2
- **AI**: Claude CLI (Opus 4.6)
- **Exchange**: Upbit REST API
- **Scheduling**: node-cron (봇), crontab (배치)
- **Notifications**: Discord Bot API (선택사항)
