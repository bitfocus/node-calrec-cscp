#!/usr/bin/env node

/** biome-ignore-all assist/source/organizeImports: <explanation> */

import { CalrecClient, channelLevelToDb, mainLevelToDb } from "./index";
import { COMMANDS } from "./protocol";

// Helper function to add timestamps to console output
function logWithTimestamp(message: string, ...args: any[]) {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] ${message}`, ...args);
}

// Parse command line arguments
function parseArgs() {
	const args = process.argv.slice(2);
	const options: {
		level?: string;
		host?: string;
		port?: number;
		help?: boolean;
	} = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--level":
			case "-l":
				options.level = args[++i];
				break;
			case "--host":
				options.host = args[++i];
				break;
			case "--port":
				options.port = parseInt(args[++i], 10);
				break;
		}
	}

	return options;
}

// Show help information
function showHelp() {
	console.log(`
Calrec CSCP Client Examples

Usage: npm run examples [options]

Options:
  -h, --help           Show this help message
  -l, --level LEVEL    Run examples for specific protocol level (v1, v20, v21, dynamic, all)
  --host HOST          Console IP address (default: 172.27.27.218)
  --port PORT          Console TCP port (default: 1337)

Protocol Levels:
  v1                   Basic commands (all consoles)
  v20                  V1 + Auxiliary send routing extensions
  v21                  V20 + Channel/Group routing to mains extensions
  dynamic              Dynamic fader count demonstration
  all                  Run all examples (default)

Examples:
  npm run examples -- --level v1
  npm run examples -- --level v20 --host 192.168.1.100
  npm run examples -- --level v21 --host 10.0.0.50 --port 1338
  npm run examples -- --level dynamic --host 192.168.1.100
`);
}

// Create a client instance with custom settings
function createClient(host: string, port: number): CalrecClient {
	return new CalrecClient(
		{
			host,
			port,
			autoReconnect: true,
			reconnectInterval: 5000,
		},
		{
			globalCommandRateMs: 10,
			faderLevelRateMs: 100,
			commandResponseTimeoutMs: 5000,
			initializationTimeoutMs: 5000,
		},
	);
}

// Set up event listeners
function setupEventListeners(client: CalrecClient) {
	client.on("ready", () => {
		logWithTimestamp("🎯 Client is ready!");
	});

	client.on("connect", () => {
		logWithTimestamp("✅ Connected to Calrec console!");
	});

	client.on("error", (error) => {
		logWithTimestamp("❌ Client error:", error);
	});

	client.on("disconnect", () => {
		logWithTimestamp("🔌 Disconnected from console");
	});

	client.on("connectionStateChange", (state) => {
		logWithTimestamp("🔄 Connection state changed to:", state);
	});

	// Real-time event listeners
	client.on("faderLevelChange", (faderId, level) => {
		const levelDb = channelLevelToDb(level);
		logWithTimestamp(
			`Fader ${faderId} level changed: ${level} (${levelDb.toFixed(1)}dB)`,
		);
	});

	client.on("faderLabelChange", (faderId, label) => {
		logWithTimestamp(`Fader ${faderId} label changed: "${label}"`);
	});

	client.on("faderCutChange", (faderId, isCut) => {
		logWithTimestamp(`Fader ${faderId} cut state: ${isCut ? "CUT" : "ON"}`);
	});

	client.on("faderPflChange", (faderId, isPfl) => {
		logWithTimestamp(`Fader ${faderId} PFL: ${isPfl ? "ON" : "OFF"}`);
	});

	client.on("mainLabelChange", (mainId, label) => {
		logWithTimestamp(`Main ${mainId} label changed: "${label}"`);
	});

	client.on("auxOutputLevelChange", (auxId, level) => {
		logWithTimestamp(`Aux ${auxId} output level changed: ${level}`);
	});

	client.on("auxRoutingChange", (auxId, routes) => {
		const activeRoutes = routes.filter(r => r).length;
		logWithTimestamp(`Aux ${auxId} routing changed: ${activeRoutes} active routes`);
	});

	client.on("mainRoutingChange", (mainId, routes) => {
		const activeRoutes = routes.filter(r => r).length;
		logWithTimestamp(`Main ${mainId} routing changed: ${activeRoutes} active routes`);
	});

	client.on("availableAuxesChange", (available) => {
		const count = available.filter(a => a).length;
		logWithTimestamp(`Available auxes changed: ${count} auxes available`);
	});

	client.on("availableMainsChange", (available) => {
		const count = available.filter(a => a).length;
		logWithTimestamp(`Available mains changed: ${count} mains available`);
	});

	client.on("stereoImageChange", (faderId, image) => {
		logWithTimestamp(`Fader ${faderId} stereo image changed:`, image);
	});

	client.on("faderAssignmentChange", (assignment) => {
		logWithTimestamp(`Fader ${assignment.faderId} assignment changed:`, assignment);
	});

	client.on("mainLevelChange", (mainId, level) => {
		const levelDb = mainLevelToDb(level);
		logWithTimestamp(`Main ${mainId} level changed: ${level} (${levelDb.toFixed(1)}dB)`);
	});

	client.on("mainPflChange", (mainId, isPfl) => {
		logWithTimestamp(`Main ${mainId} PFL: ${isPfl ? "ON" : "OFF"}`);
	});

	// Only log unsolicited messages for truly unknown commands
	client.on("unsolicitedMessage", (message) => {
		const commandName = Object.entries(COMMANDS).find(([k, v]) => v === message.command)?.[0];
		if (!commandName) {
			logWithTimestamp(`Unknown unsolicited message: Command 0x${message.command.toString(16)}, Data: ${message.data.toString("hex")}`);
		}
	});
}

// Protocol Level 1 Examples (Basic commands - all consoles)
async function runLevel1Examples(client: CalrecClient) {
	logWithTimestamp("=== Running Protocol Level 1 Examples ===");

	try {
		// Console Information
		logWithTimestamp("Getting console information...");
		const consoleInfo = await client.getConsoleInfo();
		logWithTimestamp("Console Info:", consoleInfo);

		logWithTimestamp("Getting console name...");
		const consoleName = await client.getConsoleName();
		logWithTimestamp("Console Name:", consoleName);

		// Fader Level Control
		logWithTimestamp("Setting fader 1 to -20dB...");
		await client.setFaderLevelDb(1, -20);
		logWithTimestamp("Set fader 1 to -20dB");

		logWithTimestamp("Getting fader 1 level...");
		const faderLevel = await client.getFaderLevel(1);
		const faderLevelDb = channelLevelToDb(faderLevel);
		logWithTimestamp(`Fader 1: Level ${faderLevel}, ${faderLevelDb.toFixed(1)}dB`);

		// Fader Cut Control
		logWithTimestamp("Cutting fader 1...");
		await client.setFaderCut(1, true);
		logWithTimestamp("Cut fader 1");

		logWithTimestamp("Getting fader 1 cut state...");
		const isCut = await client.getFaderCut(1);
		logWithTimestamp(`Fader 1 cut state: ${isCut ? "CUT" : "ON"}`);

		// Fader PFL Control
		logWithTimestamp("Enabling PFL on fader 1...");
		await client.setFaderPfl(1, true);
		logWithTimestamp("Enabled PFL on fader 1");

		logWithTimestamp("Getting fader 1 PFL state...");
		const isPfl = await client.getFaderPfl(1);
		logWithTimestamp(`Fader 1 PFL state: ${isPfl ? "ON" : "OFF"}`);

		// Fader Label
		logWithTimestamp("Getting fader 1 label...");
		const faderLabel = await client.getFaderLabel(1);
		logWithTimestamp(`Fader 1 label: "${faderLabel}"`);

		// Main Fader Level Control
		logWithTimestamp("Setting main fader 1 to -10dB...");
		await client.setMainFaderLevelDb(1, -10);
		logWithTimestamp("Set main fader 1 to -10dB");

		logWithTimestamp("Getting main fader 1 level...");
		const mainLevel = await client.getMainFaderLevelDb(1);
		logWithTimestamp(`Main fader 1: ${mainLevel.toFixed(1)}dB`);

		// Main Fader PFL Control
		logWithTimestamp("Enabling PFL on main fader 1...");
		await client.setMainFaderPfl(1, true);
		logWithTimestamp("Enabled PFL on main fader 1");

		logWithTimestamp("Getting main fader 1 PFL state...");
		const mainPfl = await client.getMainPfl(1);
		logWithTimestamp(`Main fader 1 PFL state: ${mainPfl ? "ON" : "OFF"}`);

		// Main Fader Label
		logWithTimestamp("Getting main fader 1 label...");
		const mainLabel = await client.getMainFaderLabel(1);
		logWithTimestamp(`Main fader 1 label: "${mainLabel}"`);

	} catch (error) {
		logWithTimestamp("Level 1 example failed:", error);
	}
}

// Protocol Level 20 Examples (Auxiliary send routing extensions)
async function runLevel20Examples(client: CalrecClient) {
	logWithTimestamp("=== Running Protocol Level 20 Examples ===");

	try {
		// Get available auxes
		logWithTimestamp("Getting available auxiliary outputs...");
		const availableAuxes = await client.getAvailableAux();
		logWithTimestamp("Available auxes:", availableAuxes);

		// Get fader assignment
		logWithTimestamp("Getting fader 1 assignment...");
		const assignment = await client.getFaderAssignment(1);
		logWithTimestamp("Fader 1 assignment:", assignment);

		// Aux routing
		logWithTimestamp("Setting aux routing for aux 1...");
		const maxFaders = client.getMaxFaderCount();
		const routes = new Array(maxFaders).fill(false);
		routes[0] = true; // Route fader 1 to aux 1
		routes[1] = true; // Route fader 2 to aux 1
		await client.setAuxRouting(1, routes);
		logWithTimestamp("Set aux routing for aux 1");

		logWithTimestamp("Getting aux routing for aux 1...");
		const auxRoutes = await client.getAuxSendRouting(1);
		logWithTimestamp("Aux 1 routing:", auxRoutes.slice(0, 10)); // Show first 10 routes

		// Aux output level
		logWithTimestamp("Setting aux 1 output level to 600...");
		await client.setAuxOutputLevel(1, 600);
		logWithTimestamp("Set aux 1 output level to 600");

		logWithTimestamp("Getting aux 1 output level...");
		const auxLevel = await client.getAuxOutputLevel(1);
		logWithTimestamp(`Aux 1 output level: ${auxLevel}`);

	} catch (error) {
		logWithTimestamp("Level 20 example failed:", error);
	}
}

// Protocol Level 21 Examples (Channel/Group routing to mains extensions)
async function runLevel21Examples(client: CalrecClient) {
	logWithTimestamp("=== Running Protocol Level 21 Examples ===");

	try {
		// Get available mains
		logWithTimestamp("Getting available main outputs...");
		const availableMains = await client.getAvailableMains();
		logWithTimestamp("Available mains:", availableMains);

		// Main routing
		logWithTimestamp("Setting main routing for main 1...");
		const maxFaders = client.getMaxFaderCount();
		const routes = new Array(maxFaders).fill(false);
		routes[0] = true; // Route fader 1 to main 1
		routes[2] = true; // Route fader 3 to main 1
		await client.setRouteToMain(1, routes);
		logWithTimestamp("Set main routing for main 1");

		logWithTimestamp("Getting main routing for main 1...");
		const mainRoutes = await client.getRouteToMain(1);
		logWithTimestamp("Main 1 routing:", mainRoutes.slice(0, 10)); // Show first 10 routes

		// Stereo image
		logWithTimestamp("Setting stereo image for fader 1...");
		await client.setStereoImage(1, { leftToBoth: true, rightToBoth: false });
		logWithTimestamp("Set stereo image for fader 1");

		logWithTimestamp("Getting stereo image for fader 1...");
		const stereoImage = await client.getStereoImage(1);
		logWithTimestamp("Fader 1 stereo image:", stereoImage);

	} catch (error) {
		logWithTimestamp("Level 21 example failed:", error);
	}
}

// Dynamic Fader Count Example
async function runDynamicFaderCountExample(client: CalrecClient) {
	logWithTimestamp("=== Running Dynamic Fader Count Example ===");

	try {
		// Get console info to see the actual fader count
		logWithTimestamp("Getting console info...");
		const consoleInfo = await client.getConsoleInfo();
		logWithTimestamp("Console info:", consoleInfo);

		// Get the effective max fader count (synchronous - uses cached info)
		const maxFaders = client.getMaxFaderCount();
		logWithTimestamp(`Effective max fader count (sync): ${maxFaders}`);

		// Get the effective max fader count (async - can wait for console info)
		const maxFadersAsync = await client.getMaxFaderCountAsync(true, 5000);
		logWithTimestamp(`Effective max fader count (async): ${maxFadersAsync}`);

		// Wait for console info to be available (if not already)
		logWithTimestamp("Waiting for console info to be available...");
		const waitedConsoleInfo = await client.waitForConsoleInfo(5000);
		if (waitedConsoleInfo) {
			logWithTimestamp("Console info is now available:", waitedConsoleInfo);
		} else {
			logWithTimestamp("Console info not available after timeout, using defaults");
		}

		// Demonstrate that routing arrays are sized correctly
		logWithTimestamp("Creating routing arrays with dynamic sizing...");
		
		// Aux routing example
		const auxRoutes = new Array(maxFaders).fill(false);
		auxRoutes[0] = true; // Route fader 1 to aux 1
		auxRoutes[Math.min(5, maxFaders - 1)] = true; // Route fader 6 (or last available) to aux 1
		logWithTimestamp(`Created aux routing array with ${auxRoutes.length} elements`);
		
		// Main routing example
		const mainRoutes = new Array(maxFaders).fill(false);
		mainRoutes[1] = true; // Route fader 2 to main 1
		mainRoutes[Math.min(10, maxFaders - 1)] = true; // Route fader 11 (or last available) to main 1
		logWithTimestamp(`Created main routing array with ${mainRoutes.length} elements`);

		// Test validation with the actual max fader count
		logWithTimestamp("Testing fader ID validation...");
		try {
			await client.getFaderLevel(maxFaders); // This should work
			logWithTimestamp(`Successfully accessed fader ${maxFaders}`);
		} catch (error) {
			logWithTimestamp(`Failed to access fader ${maxFaders}:`, error);
		}

		try {
			await client.getFaderLevel(maxFaders + 1); // This should fail
			logWithTimestamp(`Unexpectedly succeeded accessing fader ${maxFaders + 1}`);
		} catch (error) {
			logWithTimestamp(`Correctly rejected fader ${maxFaders + 1}:`, error);
		}

		// Show the difference between sync and async methods
		logWithTimestamp("=== Comparison of sync vs async methods ===");
		logWithTimestamp(`Sync getMaxFaderCount(): ${client.getMaxFaderCount()}`);
		logWithTimestamp(`Async getMaxFaderCountAsync(): ${await client.getMaxFaderCountAsync()}`);
		logWithTimestamp(`Async getMaxFaderCountAsync(waitForConsoleInfo: true): ${await client.getMaxFaderCountAsync(true)}`);

	} catch (error) {
		logWithTimestamp("Dynamic fader count example failed:", error);
	}
}

// Main execution function
async function main() {
	const options = parseArgs();

	if (options.help) {
		showHelp();
		return;
	}

	const host = options.host || "172.27.27.218";
	const port = options.port || 1337;
	const level = options.level || "all";

	logWithTimestamp(`Starting Calrec CSCP examples (Level: ${level}, Host: ${host}:${port})`);

	const client = createClient(host, port);
	setupEventListeners(client);

	try {
		// Connect to the console
		logWithTimestamp("🔗 Connecting to Calrec console...");
		await client.connect();

		// Wait for client to be ready
		await new Promise<void>((resolve) => {
			client.once("ready", resolve);
			// Timeout after 10 seconds
			setTimeout(() => resolve(), 10000);
		});

		// Run examples based on level
		switch (level.toLowerCase()) {
			case "v1":
				await runLevel1Examples(client);
				break;
			case "v20":
				await runLevel1Examples(client);
				await runLevel20Examples(client);
				break;
			case "v21":
				await runLevel1Examples(client);
				await runLevel20Examples(client);
				await runLevel21Examples(client);
				break;
			case "dynamic":
				await runDynamicFaderCountExample(client);
				break;
			case "all":
			default:
				await runLevel1Examples(client);
				await runLevel20Examples(client);
				await runLevel21Examples(client);
				await runDynamicFaderCountExample(client);
				break;
		}

		logWithTimestamp("✅ All examples completed successfully!");

	} catch (error) {
		logWithTimestamp("❌ Examples failed:", error);
	} finally {
		// Cleanup
		logWithTimestamp("🧹 Cleaning up...");
		await client.disconnect();
		logWithTimestamp("Cleanup complete");
		
		// Exit after a short delay
		/*setTimeout(() => {
			logWithTimestamp("Exiting...");
			process.exit(0);
		}, 1000);*/
	}
}

// Handle process termination
process.on("SIGINT", async () => {
	logWithTimestamp("Received SIGINT, exiting...");
	process.exit(0);
});

process.on("SIGTERM", async () => {
	logWithTimestamp("Received SIGTERM, exiting...");
	process.exit(0);
});

// Start the examples
main().catch((error) => {
	logWithTimestamp("Main execution failed:", error);
	process.exit(1);
});
