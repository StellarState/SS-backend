/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0, "always", Infinity],
    "footer-max-line-length": [0, "always", Infinity],
    "footer-leading-blank": [0, "always"],
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
        "merge",
      ],
    ],
  },
  ignores: [
    (commit) => commit.trim().toLowerCase().startsWith("fixed all issues"),
    (commit) => /^merge(\(.*\))?:/i.test(commit.trim()),
  ],
};
