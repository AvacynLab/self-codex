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

  it('keeps only the curated engines while inheriting the upstream defaults', () => {
    const defaults = config.use_default_settings as
      | { engines?: { keep_only?: unknown } }
      | undefined;

    expect(defaults, 'use_default_settings').to.be.an('object');
    const keepOnly = defaults?.engines?.keep_only as unknown;
    expect(keepOnly, 'engines.keep_only').to.be.an('array');
    expect(keepOnly).to.deep.equal([
      'duckduckgo',
      'wikipedia',
      'arxiv',
      'github',
      'qwant',
    ]);
    expect(new Set(keepOnly as string[]).size).to.equal((keepOnly as string[]).length);
  });

  it('disables the limiter to avoid requiring an external Valkey service', () => {
    const server = config.server as { limiter?: unknown } | undefined;
    expect(server, 'server section').to.be.ok;
    expect(server?.limiter).to.equal(false);
  });

  it('uses POST as the HTTP method so requests remain compatible with defaults', () => {
    const server = config.server as { method?: unknown } | undefined;
    expect(server?.method).to.equal('POST');
  });

  it('ships with a sufficiently long default secret key for development', () => {
    const server = config.server as { secret_key?: unknown } | undefined;
    expect(server?.secret_key).to.be.a('string');
    expect((server?.secret_key as string).length).to.be.greaterThanOrEqual(32);
  });

  it('configures qwant with an explicit category so the engine loads', () => {
    const engines = config.engines as Array<Record<string, unknown>> | undefined;
    expect(engines, 'engines list').to.be.an('array').that.is.not.empty;

    const qwant = engines!.find((engine) => engine.name === 'qwant');
    expect(qwant, 'qwant engine').to.be.ok;
    expect(qwant?.qwant_categ, 'qwant_categ field').to.equal('web');
  });

  it('keeps engine categories within the supported SearxNG set', () => {
    const allowedCategories = new Set([
      'general',
      'news',
      'images',
      'videos',
      'it',
      'science',
      'files',
      'music',
      'social media',
      'map',
    ]);

    const engines = config.engines as Array<Record<string, unknown>> | undefined;
    expect(engines, 'engines list').to.be.an('array').that.is.not.empty;

    for (const engine of engines!) {
      const categories = engine.categories as Array<unknown> | undefined;
      expect(categories, `categories for engine ${engine.name as string}`).to.satisfy(
        (value: unknown) => Array.isArray(value) && value.length > 0,
        'engine must declare at least one category',
      );

      for (const category of categories!) {
        expect(
          allowedCategories.has(category as string),
          `category "${String(category)}" is not supported by SearxNG`,
        ).to.equal(true);
      }
    }
  });

  it('declares unique shortcuts for every curated engine', () => {
    const engines = config.engines as Array<Record<string, unknown>> | undefined;
    expect(engines, 'engines list').to.be.an('array').that.is.not.empty;

    const seen = new Set<string>();
    for (const engine of engines!) {
      const shortcut = engine.shortcut as unknown;
      expect(shortcut, `shortcut for ${engine.name as string}`).to.be.a('string');

      const key = shortcut as string;
      expect(seen.has(key), `duplicate shortcut ${key}`).to.equal(false);
      seen.add(key);
    }
  });
});
