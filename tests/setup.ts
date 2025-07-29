// tests/setup.ts

// tests/setup.ts

// Global test configuration
beforeAll(() => {
	// Increase timeout for network operations
	jest.setTimeout(10000); // 10 seconds total
});

afterAll(() => {
	// Cleanup any remaining connections
});

// Check if we're running integration tests
export const RUN_INTEGRATION_TESTS =
	process.env.RUN_INTEGRATION_TESTS === "true";
export const SKIP_INTEGRATION_TESTS =
	process.env.SKIP_INTEGRATION_TESTS === "true";

// Test utilities
export const TEST_CONFIG = {
	host: process.env.CALREC_HOST || "172.27.27.218",
	port: parseInt(process.env.CALREC_PORT || "3322"),
	maxFaderCount: 42, // Configure for 42 faders
	maxMainCount: 3, // Configure for 3 mains
	testFaderId: 1, // Use fader 1 for testing
	testAuxId: 1, // Use aux 1 for testing
	testMainId: 1, // Use main 1 for testing
};

// Use a mock config when integration tests are disabled
export const getTestConfig = () => {
	if (SKIP_INTEGRATION_TESTS) {
		return {
			...TEST_CONFIG,
			host: "127.0.0.1", // Use localhost to ensure no connection
			port: 1, // Use invalid port
		};
	}
	return TEST_CONFIG;
};

export const TEST_SETTINGS = {
	globalCommandRateMs: 5, // Very fast for testing
	faderLevelRateMs: 10, // Very fast for testing
	commandResponseTimeoutMs: 200, // 200ms max as specified
	initializationTimeoutMs: 100, // 100ms for console info/name requests
};

// Helper function to check if integration tests should run
export const shouldRunIntegrationTest = (): boolean => {
	if (SKIP_INTEGRATION_TESTS) {
		return false;
	}
	if (RUN_INTEGRATION_TESTS) {
		return true;
	}
	// Default: run integration tests if no environment variable is set
	return true;
};

// Helper function to skip integration tests with a clear message
export const skipIfNoIntegration = (): boolean => {
	return !shouldRunIntegrationTest();
};

// Helper function to wait for a condition
export const waitFor = (
	condition: () => boolean,
	timeout = 200,
): Promise<void> => {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		const check = () => {
			if (condition()) {
				resolve();
			} else if (Date.now() - startTime > timeout) {
				reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
			} else {
				setTimeout(check, 10);
			}
		};
		check();
	});
};

// Helper function to wait for an event
export const waitForEvent = <T>(
	emitter: NodeJS.EventEmitter,
	event: string,
	timeout = 200,
): Promise<T> => {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(`Timeout waiting for event '${event}' after ${timeout}ms`),
			);
		}, timeout);

		emitter.once(event, (data: T) => {
			clearTimeout(timer);
			resolve(data);
		});
	});
};
