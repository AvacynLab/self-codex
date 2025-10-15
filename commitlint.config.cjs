/**
 * Commitlint configuration enforcing Conventional Commits so Changesets can
 * infer release types from the history. We intentionally keep the rule set
 * close to the default "conventional" preset while allowing chore/docs/test
 * entries for maintenance work.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test'
      ]
    ],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case']],
    'subject-empty': [2, 'never']
  }
};
