/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  passWithNoTests: true,
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts", "**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageDirectory: "coverage",
  verbose: true,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1", // map @/ paths to src
    "^pdfkit$": "<rootDir>/node_modules/pdfkit/js/pdfkit.standalone.js",
  },
  setupFiles: ["tsconfig-paths/register"], // ensures TS path aliases work
};