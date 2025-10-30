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

  it('defines categories_as_tabs as a dict with schema-compliant tab objects', () => {
    const ui = config.ui as { categories_as_tabs?: Record<string, unknown> } | undefined;
    expect(ui, 'ui section').to.be.an('object');

    const categories = ui?.categories_as_tabs;
    expect(categories, 'categories_as_tabs should be an object').to.be.an('object');

    const generalTab = categories?.['general'] as
      | { name?: unknown; categories?: unknown }
      | undefined;
    expect(generalTab, 'general tab config').to.deep.equal({
      name: 'General',
      categories: ['general'],
    });

    const newsTab = categories?.['news'] as { name?: unknown; categories?: unknown } | undefined;
    expect(newsTab, 'news tab config').to.deep.equal({
      name: 'News',
      categories: ['news'],
    });

    const filesTab = categories?.['files'] as { name?: unknown; categories?: unknown } | undefined;
    expect(filesTab, 'files tab config').to.deep.equal({
      name: 'Documents',
      categories: ['files'],
    });

    const imagesTab = categories?.['images'] as { name?: unknown; categories?: unknown } | undefined;
    expect(imagesTab, 'images tab config').to.deep.equal({
      name: 'Images',
      categories: ['images'],
    });
  });
});
