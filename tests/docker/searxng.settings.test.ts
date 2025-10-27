import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

describe('docker/searxng/settings.yml', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const settingsPath = path.resolve(__dirname, '../../docker/searxng/settings.yml');
  const settingsContent = readFileSync(settingsPath, 'utf8');
  const config = parse(settingsContent) as Record<string, unknown>;

  it('disables the limiter to avoid requiring an external Valkey service', () => {
    const server = config.server as { limiter?: unknown } | undefined;
    expect(server, 'server section').to.be.ok;
    expect(server?.limiter).to.equal(false);
  });

  it('ships with a sufficiently long default secret key for development', () => {
    const server = config.server as { secret_key?: unknown } | undefined;
    expect(server?.secret_key).to.be.a('string');
    expect((server?.secret_key as string).length).to.be.greaterThanOrEqual(32);
  });
});
