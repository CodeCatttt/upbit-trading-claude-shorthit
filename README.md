# upbit-trading-claude

업비트(Upbit) 거래소에서 BTC/ETH 상대가치(Relative Value) 전략으로 자동매매하는 봇입니다.
6시간마다 Claude CLI(Opus)가 시장 데이터와 전략 성과를 분석하여, 전략을 자율적으로 개선하고 배포합니다.

## 핵심 아이디어

```
기존 방식 (OpenClaw)              →  새 방식 (Claude CLI 배치)
─────────────────────────         ─────────────────────────
매 실행마다 자아/컨텍스트 로딩        정형화된 데이터만 입력
검증 없이 전략 코드 직접 파이핑       구문검사 + 인터페이스 검증 + 백테스트
롤백 없음                          자동 롤백 + 배포 이력
```

## 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    Cron (6시간마다)                       │
│                   run-batch.sh                          │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐ │
│  │  캔들    │→│  메트릭  │→│  Claude   │→│  파서  │ │
│  │  수집    │  │  수집    │  │  CLI 호출 │  │  검증  │ │
│  └──────────┘  └──────────┘  └───────────┘  └───┬────┘ │
│                                                  │      │
│                              ┌───────────┐  ┌────▼────┐ │
│                              │  배포     │←│ 백테스트│ │
│                              │  +롤백    │  │  비교   │ │
│                              └─────┬─────┘  └─────────┘ │
│                                    │                     │
│                              ┌─────▼─────┐              │
│                              │ git commit │              │
│                              │  & push    │              │
│                              └───────────┘              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  PM2 (24/7 상시 실행)                     │
│                      bot.js                             │
│                                                         │
│  15분마다 current-strategy.js 로딩 → onNewCandle 호출    │
│  → SWITCH_TO_BTC / SWITCH_TO_ETH / HOLD 판단            │
│  → Upbit API로 매매 실행                                 │
└─────────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
upbit-trading-claude/
├── .env                          # Upbit API 키
├── ecosystem.config.js           # PM2 설정
├── bot-state.json                # 봇 상태 (IN_BTC / IN_ETH)
├── deploy-log.json               # 배포 이력
│
├── src/
│   ├── bot.js                    # 매매 봇 (PM2, 15분 cron)
│   ├── upbit-api.js              # Upbit REST API 래퍼
│   ├── indicators.js             # 기술 지표 라이브러리
│   │
│   ├── strategies/
│   │   ├── current-strategy.js   # 현재 활성 전략 (배치가 교체)
│   │   ├── strategy-ou-process.js # OU Process 전략 (초기)
│   │   └── archive/              # 이전 전략 보관
│   │
│   ├── batch/
│   │   ├── run-batch.sh          # 배치 오케스트레이터 (7단계)
│   │   ├── collect-metrics.js    # 포트폴리오/시장/봇 메트릭 수집
│   │   ├── build-prompt.js       # Claude 프롬프트 조립
│   │   ├── parse-response.js     # 응답 파싱 + 코드 검증
│   │   ├── backtest.js           # 히스토리컬 백테스트 엔진
│   │   └── deploy.js             # 안전 배포 + 자동 롤백
│   │
│   ├── data/
│   │   ├── candle-fetcher.js     # Upbit 캔들 페이지네이션 수집
│   │   └── candle-store.js       # JSON 캔들 저장/병합/중복제거
│   │
│   └── utils/
│       ├── adf-test.js           # Augmented Dickey-Fuller 검정
│       └── logger.js             # 구조화된 로깅
│
├── data/
│   ├── candles/                  # BTC/ETH × 15m/240m 캔들 (각 2000개)
│   ├── metrics/                  # 배치 메트릭 스냅샷
│   └── backtest-results/         # 백테스트 결과
│
├── backups/                      # 전략 백업 (배포 전 자동 생성)
└── logs/
    ├── batch/                    # 배치 실행 로그
    └── deploy/                   # 배포 로그
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
# 6시간마다 실행 (00:30, 06:30, 12:30, 18:30)
crontab -e
# 다음 줄 추가:
30 0,6,12,18 * * * /home/kook/programming/upbit-trading-claude/src/batch/run-batch.sh >> /home/kook/programming/upbit-trading-claude/logs/batch/cron.log 2>&1
```

## 매매 전략

### 현재 전략: Ornstein-Uhlenbeck Process

BTC/ETH 가격 비율을 평균회귀(mean-reverting) 확률 과정으로 모델링합니다.

| 파라미터 | 값 | 설명 |
|----------|------|------|
| lookback | 60 | OU 파라미터 추정 기간 (15분봉 60개 = 15시간) |
| entryThreshold | 1.5 | Z-score 진입 임계값 |
| minThreshold | 1.0 | 동적 임계값 하한 |
| maxThreshold | 2.5 | 동적 임계값 상한 |

**매매 로직:**
1. BTC/ETH 가격비율 시계열에서 OU 파라미터(μ, θ, σ) 추정
2. ADF 검정으로 정상성(stationarity) 확인
3. 균형분포의 Z-score 계산
4. Z-score가 동적 임계값을 초과하면 자산 전환
   - Z > threshold → BTC 과대평가 → ETH로 전환
   - Z < -threshold → ETH 과대평가 → BTC로 전환

### 전략 인터페이스 규격

모든 전략은 다음 인터페이스를 준수해야 합니다:

```javascript
module.exports = {
    DEFAULT_CONFIG,             // { lookback, entryThreshold, ... }
    createStrategyState(),      // → { assetHeld: 'IN_BTC' }
    onNewCandle(state, btcCandles, ethCandles, config?)
    // → { action: 'SWITCH_TO_BTC'|'SWITCH_TO_ETH'|'HOLD'|'NONE', details: {} }
};
```

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

6시간마다 `run-batch.sh`가 7단계를 순차 실행합니다:

```
Step 0  캔들 수집        Upbit API → data/candles/ 갱신
Step 1  메트릭 수집      잔고, 시세, 거래내역, 봇 상태 → data/metrics/ 스냅샷
Step 2  쿨다운 체크      마지막 배포 후 12시간 미경과 시 → 종료
Step 3  Claude 호출      메트릭 + 전략소스 + 지표목록 + 백테스트이력 → Opus 분석
Step 4  응답 파싱        JSON 결정 + JS 코드 추출, 구문검사 + 인터페이스 검증
Step 5  백테스트         현재 vs 신규 전략 히스토리컬 시뮬레이션 비교
Step 6  배포             백업 → 교체 → PM2 재시작 → 30초 헬스체크 → (실패 시 롤백)
Step 7  git commit/push  변경사항 버전관리
```

### Claude의 3가지 선택지

| 결정 | 설명 | 후속 동작 |
|------|------|-----------|
| **KEEP** | 현재 전략 유지 | 종료 |
| **MODIFY** | 파라미터만 조정 | DEFAULT_CONFIG 값 교체 → git commit |
| **REPLACE** | 전략 전체 교체 | 백테스트 → 배포 → git commit & push |

## 안전장치

| 장치 | 설명 |
|------|------|
| 12시간 쿨다운 | 배포 간 최소 12시간 간격 강제 |
| 백테스트 게이트 | 수익률 +0.5% 이상 개선, 낙폭 악화 2% 이내, 일일거래 4회 이하 |
| 구문 검증 | `node -c` + `require()` + mock `onNewCandle()` 호출 |
| 30초 헬스체크 | 배포 후 PM2 상태 + 재시작 횟수 확인 |
| 자동 롤백 | 헬스체크 실패 시 백업 전략 복원 + PM2 재시작 |
| 거래 빈도 제한 | 백테스트에서 일일 4회 초과 전략 거부 |
| 감사 추적 | 배치 로그, 배포 로그, 백테스트 결과 모두 보존 |
| 백테스트 피드백 | 이전 백테스트 결과를 다음 프롬프트에 포함 (실패 학습) |

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
```

## 기술 스택

- **Runtime**: Node.js
- **Process Manager**: PM2
- **AI**: Claude CLI (Opus 모델)
- **Exchange**: Upbit REST API
- **Scheduling**: node-cron (봇), crontab (배치)
