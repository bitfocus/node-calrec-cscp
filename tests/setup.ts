// tests/setup.ts

// Global test configuration
beforeAll(() => {
	// Increase timeout for network operations
	jest.setTimeout(10000); // 10 seconds total
});

afterAll(() => {
	// Cleanup any remaining connections
});

// Test utilities
export const TEST_CONFIG = {
	host: "172.27.27.218",
	port: 1337,
	testFaderId: 1, // Use fader 1 for testing
	testAuxId: 1, // Use aux 1 for testing
	testMainId: 1, // Use main 1 for testing
};

export const TEST_SETTINGS = {
	globalCommandRateMs: 5, // Very fast for testing
	faderLevelRateMs: 10, // Very fast for testing
	commandResponseTimeoutMs: 200, // 200ms max as specified
	initializationTimeoutMs: 100, // 100ms for console info/name requests
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
