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

  it('uses POST as the HTTP method so requests remain compatible with defaults', () => {
    const server = config.server as { method?: unknown } | undefined;
    expect(server?.method).to.equal('POST');
  });

  it('ships with a sufficiently long default secret key for development', () => {
    const server = config.server as { secret_key?: unknown } | undefined;
    expect(server?.secret_key).to.be.a('string');
    expect((server?.secret_key as string).length).to.be.greaterThanOrEqual(32);
  });

  it('assigns unique shortcuts to every enabled engine', () => {
    // Each shortcut must be unique; otherwise SearxNG aborts during startup with an
    // "ambiguous shortcut" error and the container never becomes healthy.
    const engines = config.engines as Array<Record<string, unknown>> | undefined;
    expect(engines, 'engines list').to.be.an('array').that.is.not.empty;

    const shortcuts = engines!.map((engine, index) => {
      const shortcut = engine.shortcut;
      expect(shortcut, `shortcut for engine #${index + 1}`).to.be.a('string').that.is.not
        .empty;
      return shortcut as string;
    });

    const uniqueShortcuts = new Set(shortcuts);
    expect(uniqueShortcuts.size).to.equal(shortcuts.length);
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
});
