import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GraphState } from '../dist/graphState.js';

// Ces tests valident la détection d'inactivité sur la version compilée.
describe('GraphState.findInactiveChildren (dist)', () => {
  it('signale un enfant resté inactif au-delà du seuil', () => {
    const state = new GraphState();
    const baseTs = 1_000_000;
    state.createJob('job_idle', { createdAt: baseTs, state: 'running' });
    state.createChild('job_idle', 'child_idle', { name: 'Idle' }, { createdAt: baseTs, ttlAt: null });

    const reports = state.findInactiveChildren({ idleThresholdMs: 5_000, now: baseTs + 6_500 });
    assert.equal(reports.length, 1);
    const report = reports[0];
    assert.equal(report.childId, 'child_idle');
    assert.ok(report.flags.some((flag) => flag.type === 'idle'));
    assert.equal(report.idleMs, 6_500);
  });

  it('remonte les pending prolongés même sans inactivité globale', () => {
    const state = new GraphState();
    const baseTs = 2_000_000;
    state.createJob('job_pending', { createdAt: baseTs, state: 'running' });
    state.createChild('job_pending', 'child_pending', { name: 'Pending' }, { createdAt: baseTs, ttlAt: null });
    state.setPending('child_pending', 'pending_1', baseTs + 1_000);

    const reports = state.findInactiveChildren({
      idleThresholdMs: 10_000,
      pendingThresholdMs: 3_000,
      now: baseTs + 5_500
    });
    const report = reports.find((entry) => entry.childId === 'child_pending');
    assert.ok(report, 'Le pending devrait être signalé');
    const pendingFlag = report.flags.find((flag) => flag.type === 'pending');
    assert.ok(pendingFlag, 'Le flag pending est absent');
    assert.equal(pendingFlag.thresholdMs, 3_000);
    assert.equal(report.pendingMs, 4_500);
  });
});
