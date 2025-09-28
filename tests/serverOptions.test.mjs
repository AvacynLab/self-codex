import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseOrchestratorRuntimeOptions, createHttpSessionId } from '../dist/serverOptions.js';

// These tests guarantee the CLI parsing logic remains predictable when exposing
// the orchestrator over HTTP. They validate default behaviours and flag
// combinations that would be used in cloud environments.
describe('parseOrchestratorRuntimeOptions (dist)', () => {
  it('retourne la configuration stdio par défaut', () => {
    const result = parseOrchestratorRuntimeOptions([]);
    assert.equal(result.enableStdio, true);
    assert.equal(result.http.enabled, false);
    assert.equal(result.http.port, 4000);
    assert.equal(result.http.host, '0.0.0.0');
    assert.equal(result.http.path, '/mcp');
  });

  it('désactive stdio lorsque --no-stdio est présent', () => {
    const result = parseOrchestratorRuntimeOptions(['--no-stdio']);
    assert.equal(result.enableStdio, false);
  });

  it('active l HTTP avec les valeurs par défaut via --http', () => {
    const result = parseOrchestratorRuntimeOptions(['--http']);
    assert.equal(result.http.enabled, true);
    assert.equal(result.http.port, 4000);
  });

  it('applique les drapeaux HTTP explicites', () => {
    const result = parseOrchestratorRuntimeOptions([
      '--http-port',
      '8080',
      '--http-host',
      '127.0.0.1',
      '--http-path',
      'bridge',
      '--http-json',
      '--http-stateless',
    ]);
    assert.equal(result.http.enabled, true);
    assert.equal(result.http.port, 8080);
    assert.equal(result.http.host, '127.0.0.1');
    assert.equal(result.http.path, '/bridge');
    assert.equal(result.http.enableJson, true);
    assert.equal(result.http.stateless, true);
  });

  it('rejette les ports invalides', () => {
    assert.throws(() => parseOrchestratorRuntimeOptions(['--http-port', 'abc']));
  });

  it('fournit un identifiant de session UUID', () => {
    const id = createHttpSessionId();
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(id, uuidPattern);
  });
});

