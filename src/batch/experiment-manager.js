/**
 * experiment-manager.js
 * Structured experiment lifecycle: propose → backtest → deploy/reject → evaluate → learn.
 *
 * Experiment types:
 *   - parameter_test: modify strategy parameters, compare via backtest
 *   - shadow_strategy: run new strategy in parallel (shadow mode)
 *
 * Usage:
 *   const { proposeExperiment, evaluateExperiment, listActive } = require('./experiment-manager');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('EXPERIMENT');

const EXPERIMENTS_FILE = path.join(__dirname, '../../data/experiments.json');
const MAX_ACTIVE = 2;

function loadExperiments() {
    try {
        if (fs.existsSync(EXPERIMENTS_FILE)) {
            return JSON.parse(fs.readFileSync(EXPERIMENTS_FILE, 'utf8'));
        }
    } catch {}
    return { active: [], completed: [], maxActive: MAX_ACTIVE };
}

function saveExperiments(data) {
    const dir = path.dirname(EXPERIMENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = EXPERIMENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, EXPERIMENTS_FILE);
}

function generateId() {
    const existing = loadExperiments();
    const allIds = [...existing.active, ...existing.completed].map(e => e.id);
    let num = allIds.length + 1;
    while (allIds.includes(`exp-${String(num).padStart(3, '0')}`)) num++;
    return `exp-${String(num).padStart(3, '0')}`;
}

/**
 * Propose a new experiment from Claude's batch response.
 * Returns the created experiment or null if rejected.
 */
function proposeExperiment(experimentData) {
    if (!experimentData || !experimentData.hypothesis) {
        log.warn('Invalid experiment proposal: missing hypothesis');
        return null;
    }

    const experiments = loadExperiments();

    // Check active experiment limit
    if (experiments.active.length >= (experiments.maxActive || MAX_ACTIVE)) {
        log.warn(`Max active experiments (${experiments.maxActive || MAX_ACTIVE}) reached. Reject proposal.`);
        return null;
    }

    // Check for duplicate hypothesis
    const isDuplicate = experiments.active.some(e =>
        e.hypothesis === experimentData.hypothesis
    );
    if (isDuplicate) {
        log.warn('Duplicate hypothesis already active.');
        return null;
    }

    const experiment = {
        id: generateId(),
        hypothesis: experimentData.hypothesis,
        design: experimentData.design || {},
        status: 'proposed',
        successCriteria: experimentData.successCriteria || experimentData.design?.successCriteria || '',
        results: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        outcome: null,
    };

    experiments.active.push(experiment);
    saveExperiments(experiments);

    log.info(`Experiment proposed: ${experiment.id} — ${experiment.hypothesis}`);
    return experiment;
}

/**
 * Update experiment status after backtest.
 */
function updateExperimentStatus(experimentId, status, results) {
    const experiments = loadExperiments();
    const exp = experiments.active.find(e => e.id === experimentId);
    if (!exp) {
        log.warn(`Experiment ${experimentId} not found in active list.`);
        return null;
    }

    exp.status = status;
    if (results) exp.results = { ...exp.results, ...results };

    saveExperiments(experiments);
    log.info(`Experiment ${experimentId} updated: ${status}`);
    return exp;
}

/**
 * Complete an experiment (success or failure) and move to completed list.
 * Returns knowledge entries to be merged into batch memory.
 */
function completeExperiment(experimentId, outcome, finalResults) {
    const experiments = loadExperiments();
    const idx = experiments.active.findIndex(e => e.id === experimentId);
    if (idx === -1) {
        log.warn(`Experiment ${experimentId} not found.`);
        return null;
    }

    const exp = experiments.active[idx];
    exp.status = 'completed';
    exp.outcome = outcome; // 'confirmed' | 'rejected' | 'inconclusive'
    exp.completedAt = new Date().toISOString();
    if (finalResults) exp.results = { ...exp.results, ...finalResults };

    // Move from active to completed
    experiments.active.splice(idx, 1);
    experiments.completed.push(exp);

    // Trim completed to last 20
    if (experiments.completed.length > 20) {
        experiments.completed = experiments.completed.slice(-20);
    }

    saveExperiments(experiments);

    // Generate knowledge entry based on outcome
    const knowledge = {};
    if (outcome === 'confirmed') {
        knowledge.confirmed = [{
            insight: exp.hypothesis,
            evidence: `실험 ${exp.id} (${exp.startedAt} ~ ${exp.completedAt}): ${JSON.stringify(exp.results || {})}`,
        }];
    } else if (outcome === 'rejected') {
        knowledge.rejected = [{
            hypothesis: exp.hypothesis,
            reason: `실험 ${exp.id} 결과: ${JSON.stringify(exp.results || {})}`,
        }];
    }

    log.info(`Experiment ${experimentId} completed: ${outcome}`);
    return knowledge;
}

/**
 * List all active experiments.
 */
function listActive() {
    return loadExperiments().active;
}

/**
 * Get experiment by ID.
 */
function getExperiment(experimentId) {
    const experiments = loadExperiments();
    return experiments.active.find(e => e.id === experimentId) ||
           experiments.completed.find(e => e.id === experimentId) ||
           null;
}

/**
 * Process experiment action from batch response.
 * Handles the full lifecycle: propose → backtest → update status.
 */
function processExperimentAction(experimentData, backtestResult) {
    // If it's a new proposal
    if (!experimentData.id) {
        const exp = proposeExperiment(experimentData);
        if (!exp) return { success: false, reason: 'proposal_rejected' };

        // If we have backtest results, update accordingly
        if (backtestResult) {
            if (backtestResult.pass) {
                updateExperimentStatus(exp.id, 'backtest_passed', {
                    backtestReturn: backtestResult.returnImprovement,
                    backtestMdd: backtestResult.drawdownWorsening,
                });
            } else {
                updateExperimentStatus(exp.id, 'backtest_failed', {
                    backtestReturn: backtestResult.returnImprovement,
                    backtestMdd: backtestResult.drawdownWorsening,
                    gateFailure: backtestResult.reasons,
                });
            }
        }

        return { success: true, experiment: exp };
    }

    // Existing experiment evaluation
    return { success: true, experiment: getExperiment(experimentData.id) };
}

// CLI entry point
if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'list') {
        console.log(JSON.stringify(loadExperiments(), null, 2));
    } else if (cmd === 'complete' && process.argv[3] && process.argv[4]) {
        const knowledge = completeExperiment(process.argv[3], process.argv[4]);
        console.log(JSON.stringify(knowledge, null, 2));
    } else {
        console.log('Usage: node experiment-manager.js list|complete <id> <outcome>');
    }
}

module.exports = {
    proposeExperiment,
    updateExperimentStatus,
    completeExperiment,
    processExperimentAction,
    listActive,
    getExperiment,
    loadExperiments,
};
