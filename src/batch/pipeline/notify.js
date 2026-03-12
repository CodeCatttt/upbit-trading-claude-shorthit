/**
 * notify.js
 * 배치 결과를 Discord embed로 전송.
 *
 * Usage: echo '{"type":"keep","reasoning":"...","confidence":0.8}' | node notify.js
 *
 * Types:
 *   Strategy: keep, modify, modify_fail, replace_success, replace_fail, experiment, shadow_promoted, markets_updated
 *   Infra:    infra_fix_success, infra_fix_no_action
 *   Research: research_replace, research_experiment, research_findings
 */

'use strict';

const { sendEmbed } = require('../../utils/discord');

const COLORS = {
    keep: 0x808080,                // 회색
    modify: 0xE6A817,              // 노란색
    replace_success: 0x2ECC71,     // 초록색
    replace_fail: 0xE74C3C,        // 빨간색
    modify_fail: 0xE67E22,         // 주황색
    experiment: 0x9B59B6,          // 보라색
    shadow_promoted: 0x00FF88,     // 밝은 녹색
    markets_updated: 0x3498DB,     // 파란색
    infra_fix_success: 0x27AE60,   // 녹색
    infra_fix_no_action: 0x95A5A6, // 회색
    research_replace: 0x8E44AD,    // 진보라
    research_experiment: 0x2980B9,  // 파란색
    research_findings: 0x1ABC9C,   // teal
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

function formatModifyFail(data) {
    return {
        title: '⚠️ 배치 분석 완료 — 파라미터 수정 실패',
        color: COLORS.modify_fail,
        fields: [
            { name: '결정', value: '파라미터 수정 시도했으나 백테스트 미통과', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
        ],
    };
}

function formatExperiment(data) {
    return {
        title: '🧪 배치 분석 완료 — 실험 등록',
        color: COLORS.experiment,
        fields: [
            { name: '가설', value: data.hypothesis || '—', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
        ],
    };
}

function formatShadowPromoted(data) {
    return {
        title: '🌟 섀도우 전략 자동 승격',
        color: COLORS.shadow_promoted,
        fields: [
            { name: '승격된 전략', value: data.label || '—', inline: false },
            { name: '알파', value: `+${data.alpha || 0}%`, inline: true },
            { name: '섀도우 수익률', value: `${data.shadowReturn || 0}%`, inline: true },
            { name: '실험 ID', value: data.experimentId || '—', inline: true },
        ],
    };
}

function formatMarketsUpdated(data) {
    return {
        title: '🔄 관심 종목 변경',
        color: COLORS.markets_updated,
        fields: [
            { name: '새 종목 리스트', value: (data.markets || []).join(', ') || '—', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
        ],
    };
}

// --- Infra_fix notification types ---

function formatInfraFixSuccess(data) {
    const fixLines = (data.fixes || [])
        .map(f => `• \`${f.file}\`: ${f.description} [${f.severity || 'minor'}]`)
        .join('\n') || '없음';

    return {
        title: '🔩 인프라 수정 완료',
        color: COLORS.infra_fix_success,
        fields: [
            { name: '수정 내용', value: fixLines, inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
            { name: '트리거', value: data.trigger || '—', inline: true },
        ],
    };
}

function formatInfraFixFail(data) {
    const fixLines = (data.fixes || [])
        .map(f => `• \`${f.file}\`: ${f.description}`)
        .join('\n') || '없음';

    return {
        title: '⚠️ 인프라 수정 실패 — 롤백',
        color: 0xE74C3C,
        fields: [
            { name: '시도한 수정', value: fixLines, inline: false },
            { name: '실패 원인', value: data.reasoning || '—', inline: false },
            { name: '트리거', value: data.trigger || '—', inline: true },
        ],
    };
}

function formatInfraFixNoAction(data) {
    return {
        title: '🔍 인프라 점검 완료 — 이상 없음',
        color: COLORS.infra_fix_no_action,
        fields: [
            { name: '결과', value: '수정 필요 사항 없음', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '트리거', value: data.trigger || '—', inline: true },
        ],
    };
}

// --- Research notification types ---

function formatResearchReplace(data) {
    const comp = data.comparison || {};
    const findingLines = (data.findings || [])
        .slice(0, 3)
        .map(f => `• **${f.topic}**: ${f.summary?.slice(0, 100) || '—'}`)
        .join('\n') || '없음';

    return {
        title: '🔬 연구 완료 — 전략 교체',
        color: COLORS.research_replace,
        fields: [
            { name: '연구 결과', value: findingLines, inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '수익률 개선', value: `+${(comp.returnImprovement || 0).toFixed(2)}%`, inline: true },
            { name: '최대 낙폭 변화', value: `${(comp.drawdownWorsening || 0).toFixed(2)}%`, inline: true },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
        ],
    };
}

function formatResearchExperiment(data) {
    const findingLines = (data.findings || [])
        .slice(0, 3)
        .map(f => `• **${f.topic}**: ${f.summary?.slice(0, 100) || '—'}`)
        .join('\n') || '없음';

    return {
        title: '🔬 연구 완료 — 실험 제안',
        color: COLORS.research_experiment,
        fields: [
            { name: '연구 결과', value: findingLines, inline: false },
            { name: '실험 가설', value: data.hypothesis || '—', inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
        ],
    };
}

function formatResearchFindings(data) {
    const findingLines = (data.findings || [])
        .slice(0, 5)
        .map(f => `• **${f.topic}**: ${f.summary?.slice(0, 120) || '—'}`)
        .join('\n') || '없음';

    return {
        title: '🔬 연구 완료 — 인사이트 기록',
        color: COLORS.research_findings,
        fields: [
            { name: '연구 결과', value: findingLines, inline: false },
            { name: '사유', value: data.reasoning || '—', inline: false },
            { name: '신뢰도', value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
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
        case 'keep':                embed = formatKeep(data); break;
        case 'modify':              embed = formatModify(data); break;
        case 'modify_fail':         embed = formatModifyFail(data); break;
        case 'replace_success':     embed = formatReplaceSuccess(data); break;
        case 'replace_fail':        embed = formatReplaceFail(data); break;
        case 'markets_updated':     embed = formatMarketsUpdated(data); break;
        case 'experiment':          embed = formatExperiment(data); break;
        case 'shadow_promoted':     embed = formatShadowPromoted(data); break;
        // Infra_fix types
        case 'infra_fix_success':   embed = formatInfraFixSuccess(data); break;
        case 'infra_fix_fail':      embed = formatInfraFixFail(data); break;
        case 'infra_fix_no_action': embed = formatInfraFixNoAction(data); break;
        // Research types
        case 'research_replace':    embed = formatResearchReplace(data); break;
        case 'research_experiment': embed = formatResearchExperiment(data); break;
        case 'research_findings':   embed = formatResearchFindings(data); break;
        default:
            console.error('Unknown type:', data.type);
            process.exit(1);
    }

    await sendEmbed(embed);
}

main().catch(e => { console.error(e.message); process.exit(1); });
