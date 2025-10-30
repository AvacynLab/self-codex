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

  it('exposes a HTTP healthcheck for searxng so Docker waits for readiness', () => {
    const services = config.services as Record<string, { healthcheck?: { test?: unknown[] } }>;
    expect(services, 'services block').to.be.ok;
    const searxng = services.searxng;
    expect(searxng, 'searxng service').to.be.ok;

    const probe = searxng?.healthcheck?.test as unknown[] | undefined;
    expect(probe, 'healthcheck test command').to.be.an('array');
    expect(probe?.[0]).to.equal('CMD-SHELL');
    const command = String(probe?.[1] ?? '');
    expect(command).to.include('--request POST');
    expect(command).to.include("--data-urlencode 'q=healthcheck'");
    expect(command).to.include("--data-urlencode 'format=json'");
    expect(command).to.include('http://127.0.0.1:8080/search');
  });

  it('waits for searxng via service_healthy to honour the healthcheck', () => {
    const services = config.services as Record<string, Record<string, unknown>>;
    const server = services.server as { depends_on?: Record<string, { condition?: string }> } | undefined;
    expect(server?.depends_on?.searxng?.condition).to.equal('service_healthy');
  });
});
