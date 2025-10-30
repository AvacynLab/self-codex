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

  it('declares a curated engine catalogue with safe defaults', () => {
    expect(config.use_default_settings).to.equal(false);

    const engines = config.engines as Array<{ name?: unknown }> | undefined;
    expect(engines, 'engines overrides').to.be.an('array');

    const engineNames = new Set((engines ?? []).map((engine) => String(engine?.name ?? '')));
    expect(engineNames).to.include('duckduckgo');
    expect(engineNames).to.include('wikipedia');
    expect(engineNames).to.include('arxiv');
    expect(engineNames).to.include('github');
    expect(engineNames).to.include('mojeek');
  });

  it('defaults safe_search to 0 so callers can opt-in via env overrides', () => {
    const search = config.search as { safe_search?: unknown } | undefined;
    expect(search?.safe_search).to.equal(0);
  });

  it('disables the limiter to avoid requiring an external Valkey service', () => {
    const server = config.server as { limiter?: unknown } | undefined;
    expect(server, 'server section').to.be.ok;
    expect(server?.limiter).to.equal(false);
  });

  it('keeps GET available so automated tooling can query without CSRF negotiation', () => {
    const server = config.server as { method?: unknown } | undefined;
    expect(server?.method).to.equal('GET');
  });

  it('ships with a sufficiently long default secret key for development', () => {
    const server = config.server as { secret_key?: unknown } | undefined;
    expect(server?.secret_key).to.be.a('string');
    expect((server?.secret_key as string).length).to.be.greaterThanOrEqual(32);
  });

  it('documents the runtime allow-list to avoid configuration drift', () => {
    const fileContent = readFileSync(settingsPath, 'utf8');
    expect(fileContent).to.contain('SEARCH_SEARX_ENGINES');
    expect(fileContent).to.contain('SEARCH_SEARX_CATEGORIES');
  });

  it('defines categories_as_tabs as a dict mapping tabs to engine categories', () => {
    const categories = config.categories_as_tabs as Record<string, unknown> | undefined;
    expect(categories, 'categories_as_tabs should be an object').to.be.an('object');

    const generalTab = categories?.['general'];
    expect(generalTab, 'general tab mapping').to.deep.equal(['general']);

    const newsTab = categories?.['news'];
    expect(newsTab, 'news tab mapping').to.deep.equal(['news']);

    const filesTab = categories?.['files'];
    expect(filesTab, 'files tab mapping').to.deep.equal(['files']);

    const imagesTab = categories?.['images'];
    expect(imagesTab, 'images tab mapping').to.deep.equal(['images']);
  });
});
