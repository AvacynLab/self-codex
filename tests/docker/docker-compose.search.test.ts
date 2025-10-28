import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

describe('docker/docker-compose.search.yml', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const composePath = path.resolve(__dirname, '../../docker/docker-compose.search.yml');
  const config = parse(readFileSync(composePath, 'utf8')) as Record<string, unknown>;

  it('omits a searxng healthcheck so Docker start failures do not block the stack', () => {
    const services = config.services as Record<string, { healthcheck?: unknown }>;
    expect(services, 'services block').to.be.ok;
    expect(services.searxng, 'searxng service').to.be.ok;
    expect(services.searxng?.healthcheck).to.be.undefined;
  });

  it('waits for searxng via service_started since no healthcheck is available', () => {
    const services = config.services as Record<string, Record<string, unknown>>;
    const server = services.server as { depends_on?: Record<string, { condition?: string }> } | undefined;
    expect(server?.depends_on?.searxng?.condition).to.equal('service_started');
  });
});
