/**
 * update-memory.js
 * Appends batch decision entries to data/batch-memory.json.
 * Manages structured knowledge base (confirmed/hypotheses/rejected).
 * Trims to maxEntries.
 *
 * Usage: node src/batch/update-memory.js '{"action":"keep","reasoning":"...","confidence":0.7,"outcome":"kept"}'
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '../../data/batch-memory.json');

const DEFAULT_MEMORY = {
    maxEntries: 50,
    entries: [],
    knowledge: {
        confirmed: [],
        hypotheses: [],
        rejected: [],
    },
    // Legacy field kept for backward compat reads; no longer written to
    strategicNotes: '',
};

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const mem = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
            // Ensure knowledge structure exists (migration)
            if (!mem.knowledge) {
                mem.knowledge = { confirmed: [], hypotheses: [], rejected: [] };
            }
            return mem;
        }
    } catch {}
    return { ...DEFAULT_MEMORY, knowledge: { ...DEFAULT_MEMORY.knowledge } };
}

function saveMemory(memory) {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write
    const tmpFile = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(memory, null, 2));
    fs.renameSync(tmpFile, MEMORY_FILE);
}

/**
 * Extract key topic keywords from a text for similarity comparison.
 * Returns an array of normalized keywords.
 */
function extractTopicKeywords(text) {
    const keywords = [];
    const patterns = [
        /체결\s*강도/g, /divergence/gi, /역?divergence/gi,
        /분산/g, /레짐/g, /매수\s*우위/g, /매도\s*우위/g,
        /트레일링\s*스탑/g, /그레이스\s*기간/g, /쿨다운/g,
        /MDD/gi, /RSI/gi, /EMA/gi,
    ];
    for (const pat of patterns) {
        if (pat.test(text)) keywords.push(pat.source.replace(/\\s\*/g, ' '));
        pat.lastIndex = 0; // reset regex state
    }
    return keywords;
}

/**
 * Check if two entries are similar based on shared topic keywords.
 * Returns true if they share 2+ keywords (strongly related topic).
 */
function areSimilarEntries(textA, textB) {
    const kwA = extractTopicKeywords(textA);
    const kwB = extractTopicKeywords(textB);
    const shared = kwA.filter(k => kwB.includes(k));
    return shared.length >= 2;
}

/**
 * Deduplicate entries within a category by topic similarity.
 * If 3+ entries share the same topic, keep only the most recent one.
 */
function deduplicateByTopic(entries, textField) {
    if (entries.length <= 2) return entries;

    // Group by similarity
    const groups = [];
    const assigned = new Set();

    for (let i = 0; i < entries.length; i++) {
        if (assigned.has(i)) continue;
        const group = [i];
        assigned.add(i);
        for (let j = i + 1; j < entries.length; j++) {
            if (assigned.has(j)) continue;
            if (areSimilarEntries(entries[i][textField], entries[j][textField])) {
                group.push(j);
                assigned.add(j);
            }
        }
        groups.push(group);
    }

    // For groups with 3+ entries, keep only the most recent one
    const keepIndices = new Set();
    for (const group of groups) {
        if (group.length >= 3) {
            // Keep the last entry (most recent)
            keepIndices.add(group[group.length - 1]);
        } else {
            for (const idx of group) keepIndices.add(idx);
        }
    }

    return entries.filter((_, i) => keepIndices.has(i));
}

/**
 * Detect and consolidate observation counter patterns in hypotheses.
 * Patterns like "N회차 관측" get consolidated into a single entry
 * with an observationCount field instead of spawning duplicates.
 */
function consolidateObservationCounters(hypotheses) {
    const counterPattern = /(\d+)회차\s*관측/;

    for (const item of hypotheses) {
        const match = item.hypothesis.match(counterPattern);
        if (match) {
            item.observationCount = parseInt(match[1], 10);
        }
    }

    return hypotheses;
}

/**
 * Merge incoming knowledge updates into the knowledge base.
 * - confirmed: append new insights (keyword-based dedup)
 * - hypotheses: append new, update existing (with observation counter consolidation)
 * - rejected: append new rejections
 * Caps each category at 20 entries (keep most recent).
 */
function mergeKnowledge(memory, incomingKnowledge) {
    if (!incomingKnowledge) return;

    const kb = memory.knowledge;
    const now = new Date().toISOString().slice(0, 10);

    // Confirmed insights
    if (Array.isArray(incomingKnowledge.confirmed)) {
        for (const item of incomingKnowledge.confirmed) {
            if (!item.insight) continue;
            // Check exact match
            const exactMatch = kb.confirmed.some(k => k.insight === item.insight);
            if (exactMatch) continue;

            // Check similar entry — if found, replace with newer version
            const similarIdx = kb.confirmed.findIndex(k => areSimilarEntries(k.insight, item.insight));
            if (similarIdx !== -1) {
                // Replace older similar entry with the new one
                kb.confirmed[similarIdx] = {
                    insight: item.insight,
                    evidence: item.evidence || '',
                    addedAt: item.addedAt || now,
                };
            } else {
                kb.confirmed.push({
                    insight: item.insight,
                    evidence: item.evidence || '',
                    addedAt: item.addedAt || now,
                });
            }
        }

        // Deduplicate by topic similarity (catch any remaining clusters)
        kb.confirmed = deduplicateByTopic(kb.confirmed, 'insight');

        if (kb.confirmed.length > 20) {
            kb.confirmed = kb.confirmed.slice(-20);
        }
    }

    // Hypotheses
    if (Array.isArray(incomingKnowledge.hypotheses)) {
        for (const item of incomingKnowledge.hypotheses) {
            if (!item.hypothesis) continue;

            // Check for observation counter pattern — consolidate instead of adding
            const counterMatch = item.hypothesis.match(/(\d+)회차\s*관측/);
            if (counterMatch) {
                // Find existing hypothesis on the same topic
                const existingIdx = kb.hypotheses.findIndex(h =>
                    areSimilarEntries(h.hypothesis, item.hypothesis)
                );
                if (existingIdx !== -1) {
                    // Update existing entry's count and text
                    kb.hypotheses[existingIdx].hypothesis = item.hypothesis;
                    kb.hypotheses[existingIdx].observationCount = parseInt(counterMatch[1], 10);
                    if (item.status) kb.hypotheses[existingIdx].status = item.status;
                    continue;
                }
            }

            // Standard dedup: exact match
            const existing = kb.hypotheses.find(h => h.hypothesis === item.hypothesis);
            if (existing) {
                if (item.status) existing.status = item.status;
                if (item.experimentId) existing.experimentId = item.experimentId;
            } else {
                // Check similarity — replace if similar
                const similarIdx = kb.hypotheses.findIndex(h =>
                    areSimilarEntries(h.hypothesis, item.hypothesis)
                );
                if (similarIdx !== -1) {
                    kb.hypotheses[similarIdx] = {
                        hypothesis: item.hypothesis,
                        status: item.status || 'proposed',
                        experimentId: item.experimentId || null,
                        observationCount: counterMatch ? parseInt(counterMatch[1], 10) : undefined,
                        addedAt: item.addedAt || now,
                    };
                } else {
                    kb.hypotheses.push({
                        hypothesis: item.hypothesis,
                        status: item.status || 'proposed',
                        experimentId: item.experimentId || null,
                        addedAt: item.addedAt || now,
                    });
                }
            }
        }

        // Consolidate observation counters
        kb.hypotheses = consolidateObservationCounters(kb.hypotheses);

        // Deduplicate by topic similarity
        kb.hypotheses = deduplicateByTopic(kb.hypotheses, 'hypothesis');

        if (kb.hypotheses.length > 20) {
            kb.hypotheses = kb.hypotheses.slice(-20);
        }
    }

    // Rejected
    if (Array.isArray(incomingKnowledge.rejected)) {
        for (const item of incomingKnowledge.rejected) {
            if (!item.hypothesis) continue;
            const exists = kb.rejected.some(r => r.hypothesis === item.hypothesis);
            if (!exists) {
                kb.rejected.push({
                    hypothesis: item.hypothesis,
                    reason: item.reason || '',
                    rejectedAt: item.rejectedAt || now,
                });
                // Also remove from hypotheses if present
                kb.hypotheses = kb.hypotheses.filter(h => h.hypothesis !== item.hypothesis);
            }
        }
        if (kb.rejected.length > 20) {
            kb.rejected = kb.rejected.slice(-20);
        }
    }
}

function appendEntry(data) {
    const memory = loadMemory();

    const entry = {
        timestamp: new Date().toISOString(),
        action: data.action || 'unknown',
        reasoning: data.reasoning || '',
        confidence: data.confidence || 0,
        parameters: data.parameters || null,
        markets: data.markets || null,
        improvementAreas: data.improvementAreas || null,
        backtestResult: data.backtestResult || null,
        outcome: data.outcome || 'unknown',
        notes: data.notes || '',
        retryAttempts: data.retryAttempts || null,
        variantsTested: data.variantsTested || null,
        diagnosis: data.diagnosis || null,
        triggerType: data.triggerType || null,
    };

    memory.entries.push(entry);

    // Trim to maxEntries
    const max = memory.maxEntries || 50;
    if (memory.entries.length > max) {
        memory.entries = memory.entries.slice(-max);
    }

    // Merge structured knowledge if provided
    if (data.knowledge) {
        mergeKnowledge(memory, data.knowledge);
    }

    // Legacy: still accept strategicNotes for backward compat
    if (data.strategicNotes !== undefined && data.strategicNotes !== null) {
        memory.strategicNotes = data.strategicNotes;
    }

    saveMemory(memory);
    return entry;
}

/**
 * Migrate existing batch-memory.json from old format (strategicNotes string)
 * to new format (knowledge object). Safe to run multiple times.
 */
function migrateMemory() {
    const memory = loadMemory();

    // Already migrated
    if (memory.knowledge && (memory.knowledge.confirmed.length > 0 ||
        memory.knowledge.hypotheses.length > 0 ||
        memory.knowledge.rejected.length > 0)) {
        return false;
    }

    // Parse strategicNotes into confirmed insights
    if (memory.strategicNotes && typeof memory.strategicNotes === 'string') {
        const notes = memory.strategicNotes.split(/\d+\)\s*/).filter(Boolean);
        const now = new Date().toISOString().slice(0, 10);

        for (const note of notes) {
            const trimmed = note.trim();
            if (!trimmed) continue;
            memory.knowledge.confirmed.push({
                insight: trimmed,
                evidence: 'migrated from strategicNotes',
                addedAt: now,
            });
        }
    }

    saveMemory(memory);
    return true;
}

// CLI entry point
if (require.main === module) {
    const input = process.argv[2];

    if (input === '--migrate') {
        const migrated = migrateMemory();
        console.log(migrated ? 'Migration complete.' : 'Already migrated or no data.');
        process.exit(0);
    }

    if (!input) {
        console.error('Usage: node update-memory.js \'{"action":"keep",...}\' | --migrate');
        process.exit(1);
    }
    try {
        const data = JSON.parse(input);
        const entry = appendEntry(data);
        console.log(JSON.stringify(entry, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

module.exports = { loadMemory, appendEntry, mergeKnowledge, migrateMemory };
