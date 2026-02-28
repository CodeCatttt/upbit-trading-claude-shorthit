/**
 * notify.js
 * 배치 결과를 Discord embed로 전송.
 *
 * Usage: echo '{"type":"keep","reasoning":"...","confidence":0.8}' | node notify.js
 *
 * type: "keep" | "modify" | "replace_success" | "replace_fail"
 */

'use strict';

const { sendEmbed } = require('../utils/discord');

const COLORS = {
    keep: 0x808080,           // 회색
    modify: 0xE6A817,         // 노란색
    replace_success: 0x2ECC71, // 초록색
    replace_fail: 0xE74C3C,   // 빨간색
};

function formatKeep(data) {
    return {
        title: '📊 배치 분석 완료 — 전략 유지',
        color: COLORS.keep,
        fields: [
            { name: '결정', value: '현재 전략 유지 (변경 없음)', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
        ],
    };
}

function formatModify(data) {
    const paramLines = Object.entries(data.parameters || {})
        .map(([k, v]) => `• \`${k}\`: ${v}`)
        .join('\n') || '없음';

    return {
        title: '🔧 배치 분석 완료 — 파라미터 수정',
        color: COLORS.modify,
        fields: [
            { name: '결정', value: '전략 파라미터 조정', inline: false },
            { name: '변경 항목', value: paramLines, inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
        ],
    };
}

function formatReplaceSuccess(data) {
    const comp = data.comparison || {};
    const reasons = (comp.reasons || []).filter(r => r !== 'PASSED');

    return {
        title: '🚀 배치 분석 완료 — 전략 교체 성공',
        color: COLORS.replace_success,
        fields: [
            { name: '결정', value: '새 전략으로 교체 완료', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '수익률 개선', value: `+${(comp.returnImprovement || 0).toFixed(2)}%`, inline: true },
            { name: '최대 낙폭 변화', value: `${(comp.drawdownWorsening || 0).toFixed(2)}%`, inline: true },
            { name: '일일 거래 횟수', value: `${comp.dailyTrades || 0}회`, inline: true },
            { name: '백테스트 상세', value: reasons.map(r => `• ${r}`).join('\n') || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
        ],
    };
}

function formatReplaceFail(data) {
    const comp = data.comparison || {};
    const reasons = (comp.reasons || []).filter(r => r !== 'FAILED');

    return {
        title: '❌ 배치 분석 완료 — 전략 교체 실패',
        color: COLORS.replace_fail,
        fields: [
            { name: '결정', value: '새 전략 제안했으나 백테스트 미통과', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '수익률 차이', value: `${(comp.returnImprovement || 0).toFixed(2)}% (기준: ≥0.5%)`, inline: true },
            { name: '낙폭 악화', value: `${(comp.drawdownWorsening || 0).toFixed(2)}% (기준: ≤2.0%)`, inline: true },
            { name: '일일 거래', value: `${comp.dailyTrades || 0}회 (기준: ≤4)`, inline: true },
            { name: '실패 사유', value: reasons.map(r => `• ${r}`).join('\n') || '—', inline: false },
        ],
    };
}

function formatMarketsUpdated(data) {
    return {
        title: '🔄 관심 종목 변경',
        color: 0x3498DB, // 파란색
        fields: [
            { name: '새 종목 리스트', value: (data.markets || []).join(', ') || '—', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
        ],
    };
}

async function main() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;

    const data = JSON.parse(input);
    let embed;

    switch (data.type) {
        case 'keep':             embed = formatKeep(data); break;
        case 'modify':           embed = formatModify(data); break;
        case 'replace_success':  embed = formatReplaceSuccess(data); break;
        case 'replace_fail':     embed = formatReplaceFail(data); break;
        case 'markets_updated':  embed = formatMarketsUpdated(data); break;
        default:
            console.error('Unknown type:', data.type);
            process.exit(1);
    }

    await sendEmbed(embed);
}

main().catch(e => { console.error(e.message); process.exit(1); });
