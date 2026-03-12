/**
 * parse-research-response.js
 * Parses Claude's research response for the 3-tier autonomous batch system.
 * Handles research-tier actions: replace_strategy, propose_experiment, no_action.
 * Reuses extraction/validation utilities from parse-response.js.
 *
 * Usage: echo "$CLAUDE_OUTPUT" | node parse-research-response.js
 * Outputs validated JSON to stdout with { valid, decision, strategyCode?, strategyVariants, customIndicatorsCode?, errors }
 */

'use strict';

const { createLogger } = require('../../utils/logger');
const {
    extractLastJsonBlock,
    extractLastJsBlock,
    extractAllJsBlocks,
    extractCustomIndicatorsBlock,
    validateStrategyCode,
    validateCustomIndicators,
} = require('./parse-response');

const log = createLogger('PARSE-RESEARCH-RESPONSE');

// --- Valid actions for research tier ---

const VALID_ACTIONS = ['replace_strategy', 'propose_experiment', 'no_action'];

// --- Research decision validation ---

function validateResearchDecision(decision) {
    const errors = [];

    if (!decision) {
        errors.push('No decision JSON found');
        return errors;
    }

    // action
    if (!VALID_ACTIONS.includes(decision.action)) {
        errors.push(`Invalid action: ${decision.action} (must be one of: ${VALID_ACTIONS.join(', ')})`);
    }

    // reasoning (required, non-empty string)
    if (typeof decision.reasoning !== 'string' || decision.reasoning.length === 0) {
        errors.push('Missing or empty reasoning');
    }

    // confidence (required, number 0-1)
    if (typeof decision.confidence !== 'number' || decision.confidence < 0 || decision.confidence > 1) {
        errors.push(`Invalid confidence: ${decision.confidence} (must be number 0-1)`);
    }

    // findings (optional array of objects)
    if (decision.findings !== undefined) {
        if (!Array.isArray(decision.findings)) {
            errors.push('findings must be an array');
        } else {
            for (let i = 0; i < decision.findings.length; i++) {
                const f = decision.findings[i];
                if (typeof f !== 'object' || f === null) {
                    errors.push(`findings[${i}] must be an object`);
                    continue;
                }
                if (typeof f.topic !== 'string' || f.topic.length === 0) {
                    errors.push(`findings[${i}].topic must be a non-empty string`);
                }
                if (typeof f.summary !== 'string' || f.summary.length === 0) {
                    errors.push(`findings[${i}].summary must be a non-empty string`);
                }
                if (f.source !== undefined && typeof f.source !== 'string') {
                    errors.push(`findings[${i}].source must be a string`);
                }
                if (f.actionable !== undefined && typeof f.actionable !== 'boolean') {
                    errors.push(`findings[${i}].actionable must be a boolean`);
                }
            }
        }
    }

    // knowledge (optional object with confirmed/hypotheses/rejected arrays)
    if (decision.knowledge !== undefined) {
        if (typeof decision.knowledge !== 'object' || decision.knowledge === null) {
            errors.push('knowledge must be an object with confirmed/hypotheses/rejected arrays');
        } else {
            const knowledgeKeys = ['confirmed', 'hypotheses', 'rejected'];
            for (const key of knowledgeKeys) {
                if (decision.knowledge[key] !== undefined && !Array.isArray(decision.knowledge[key])) {
                    errors.push(`knowledge.${key} must be an array`);
                }
            }
        }
    }

    // experiment (required if action is propose_experiment)
    if (decision.action === 'propose_experiment') {
        if (!decision.experiment || typeof decision.experiment !== 'object') {
            errors.push('action="propose_experiment" requires an "experiment" field');
        } else {
            if (!decision.experiment.hypothesis || typeof decision.experiment.hypothesis !== 'string') {
                errors.push('experiment.hypothesis is required and must be a non-empty string');
            }
            if (!decision.experiment.design || typeof decision.experiment.design !== 'object') {
                errors.push('experiment.design is required and must be an object');
            } else if (!decision.experiment.design.type || typeof decision.experiment.design.type !== 'string') {
                errors.push('experiment.design.type is required and must be a string');
            }
        }
    }

    // notes (optional string)
    if (decision.notes !== undefined && typeof decision.notes !== 'string') {
        errors.push('notes must be a string');
    }

    return errors;
}

// --- Main parse function ---

function parseResearchResponse(text) {
    const errors = [];

    // 1. Extract and validate decision JSON
    const decision = extractLastJsonBlock(text);
    const decisionErrors = validateResearchDecision(decision);
    errors.push(...decisionErrors);

    let strategyCode = null;
    let strategyVariants = [];
    let customIndicatorsCode = null;

    if (decision) {
        // 2. Handle replace_strategy: extract and validate code blocks
        if (decision.action === 'replace_strategy') {
            const allBlocks = extractAllJsBlocks(text);
            strategyVariants = allBlocks;

            // Backward compat: use the last JS block as primary strategyCode
            strategyCode = extractLastJsBlock(text);

            if (!strategyCode) {
                errors.push('action="replace_strategy" requires at least one ```javascript code block');
            } else {
                const codeErrors = validateStrategyCode(strategyCode);
                errors.push(...codeErrors);
            }

            // Extract optional custom-indicators block
            customIndicatorsCode = extractCustomIndicatorsBlock(text);
            if (customIndicatorsCode) {
                const indicatorErrors = validateCustomIndicators(customIndicatorsCode);
                errors.push(...indicatorErrors);
            }
        }

        // 3. Handle propose_experiment: validate experiment + optional shadow strategy code
        if (decision.action === 'propose_experiment' && decision.experiment) {
            const design = decision.experiment.design;
            if (design && design.type === 'shadow_strategy') {
                strategyCode = extractLastJsBlock(text);
                strategyVariants = extractAllJsBlocks(text);

                if (strategyCode) {
                    const codeErrors = validateStrategyCode(strategyCode);
                    errors.push(...codeErrors);

                    customIndicatorsCode = extractCustomIndicatorsBlock(text);
                    if (customIndicatorsCode) {
                        const indicatorErrors = validateCustomIndicators(customIndicatorsCode);
                        errors.push(...indicatorErrors);
                    }
                } else {
                    errors.push('experiment.design.type="shadow_strategy" requires a ```javascript code block');
                }
            }
        }

        // 4. Handle no_action: no code blocks needed
        // findings and knowledge already validated above in validateResearchDecision
    }

    return {
        valid: errors.length === 0,
        decision: decision || null,
        strategyCode,
        strategyVariants,
        customIndicatorsCode,
        errors,
    };
}

// --- CLI entry point ---

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        const result = parseResearchResponse(input);
        console.log(JSON.stringify(result, null, 2));
        if (!result.valid) {
            log.error('Validation failed:', result.errors);
            process.exit(1);
        }
    });
}

module.exports = { parseResearchResponse };
