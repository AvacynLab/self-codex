/**
 * @file Tests ensuring the shared ESLint configuration loads and enforces baseline rules.
 */
import path from 'node:path';
import { expect } from 'chai';
import { FlatESLint } from 'eslint/use-at-your-own-risk';
import { fileURLToPath } from 'node:url';
import eslintConfig from '../../eslint.config.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');
const flatConfigFilePath = path.join(projectRoot, 'eslint.config.js');
const lintFixturePath = path.join(projectRoot, 'tests', 'lint', '__fixtures__', 'lint-target.ts');

describe('lint/eslint.config', function () {
  this.timeout(10_000);
  /**
   * Reuse a single ESLint instance wired to the real flat-config file so the
   * tests exercise the exact configuration loaded by `npm run lint:eslint`.
   * Using `overrideConfigFile` ensures ESLint resolves plugins and parser
   * options exactly as the CLI would, while the explicit import keeps the test
   * coupled to the exported config for regression detection.
   */
  const eslint = new FlatESLint({
    cwd: projectRoot,
    overrideConfigFile: flatConfigFilePath,
    overrideConfig: eslintConfig,
  });

  before(async () => {
    /**
     * Warm up the shared TypeScript program so individual test cases avoid
     * paying the full project parsing cost, which keeps the suite comfortably
     * under the extended timeout even on slower CI runners.
     */
    await eslint.lintText('const warmup = 0;\n', { filePath: lintFixturePath });
  });

  it('flags forbidden var declarations through the shared rule-set', async () => {
    const [report] = await eslint.lintText('var answer = 42;\n', {
      filePath: lintFixturePath,
    });

    expect(report.errorCount).to.be.greaterThan(0, 'no diagnostics were reported');
    expect(
      report.messages.some((message) => message.ruleId === 'no-var'),
      'expected the no-var rule to surface an error',
    ).to.equal(true);
  });

  it('accepts modern const/let usage when no rules are violated', async () => {
    const [report] = await eslint.lintText('const answer = 42;\n', {
      filePath: lintFixturePath,
    });

    expect(report.errorCount).to.equal(0);
    expect(report.warningCount).to.equal(0);
  });
});
