module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	roots: ["<rootDir>/src", "<rootDir>/tests"],
	testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
	testPathIgnorePatterns: ["<rootDir>/src/test.ts"], // Exclude src/test.ts from being treated as a test
	transform: {
		"^.+\\.ts$": "ts-jest",
	},
	collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/examples.ts"],
	coverageDirectory: "coverage",
	coverageReporters: ["text", "lcov", "html"],
	testTimeout: 30000, // 30 seconds for network operations
	setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
	verbose: true, // Show individual test results
};
