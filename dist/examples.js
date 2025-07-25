#!/usr/bin/env node
"use strict";
/** biome-ignore-all assist/source/organizeImports: <explanation> */
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
const protocol_1 = require("./protocol");
// Helper function to add timestamps to console output
function logWithTimestamp(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}
// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
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
  -l, --level LEVEL    Run examples for specific protocol level (v1, v20, v21, all)
  --host HOST          Console IP address (default: 172.27.27.218)
  --port PORT          Console TCP port (default: 3322)

Protocol Levels:
  v1                   Basic commands (all consoles)
  v20                  V1 + Auxiliary send routing extensions
  v21                  V20 + Channel/Group routing to mains extensions
  all                  Run all examples (default)

Examples:
  npm run examples -- --level v1
  npm run examples -- --level v20 --host 192.168.1.100
  npm run examples -- --level v21 --host 10.0.0.50 --port 1338
`);
}
// Create a client instance with custom settings
function createClient(host, port) {
    return new index_1.CalrecClient({
        host,
        port,
        maxFaderCount: 42, // Configure for 42 faders
        maxMainCount: 3, // Configure for 3 mains
        autoReconnect: true,
        reconnectInterval: 5000,
    }, {
        globalCommandRateMs: 10,
        faderLevelRateMs: 100,
        commandResponseTimeoutMs: 5000,
        initializationTimeoutMs: 5000,
    });
}
// Set up event listeners
function setupEventListeners(client) {
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
        const levelDb = (0, index_1.channelLevelToDb)(level);
        logWithTimestamp(`Fader ${faderId} level changed: ${level} (${levelDb.toFixed(1)}dB)`);
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
        const levelDb = (0, index_1.mainLevelToDb)(level);
        logWithTimestamp(`Main ${mainId} level changed: ${level} (${levelDb.toFixed(1)}dB)`);
    });
    client.on("mainPflChange", (mainId, isPfl) => {
        logWithTimestamp(`Main ${mainId} PFL: ${isPfl ? "ON" : "OFF"}`);
    });
    // Only log unsolicited messages for truly unknown commands (reduce verbosity)
    let unknownCommandCount = 0;
    client.on("unsolicitedMessage", (message) => {
        const commandName = Object.entries(protocol_1.COMMANDS).find(([k, v]) => v === message.command)?.[0];
        if (!commandName) {
            // Only log the first few unknown commands to avoid spam
            unknownCommandCount++;
            if (unknownCommandCount <= 3) {
                logWithTimestamp(`Unknown unsolicited message: Command 0x${message.command.toString(16)}, Data: ${message.data.toString("hex")}`);
            }
            else if (unknownCommandCount === 4) {
                logWithTimestamp(`... (suppressing further unknown command logs)`);
            }
        }
    });
}
// Protocol Level 1 Examples (Basic commands - all consoles)
async function runLevel1Examples(client) {
    logWithTimestamp("=== Running Protocol Level 1 Examples ===");
    try {
        // Add timeout wrapper for each command
        const timeoutWrapper = (promise, timeoutMs = 3000) => {
            return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs))
            ]);
        };
        // Console Information
        logWithTimestamp("Getting console information...");
        try {
            const consoleInfo = await timeoutWrapper(client.getConsoleInfo());
            logWithTimestamp("Console Info:", consoleInfo);
        }
        catch (error) {
            logWithTimestamp("Failed to get console info:", error);
        }
        logWithTimestamp("Getting console name...");
        try {
            const consoleName = await timeoutWrapper(client.getConsoleName());
            logWithTimestamp("Console Name:", consoleName);
        }
        catch (error) {
            logWithTimestamp("Failed to get console name:", error);
        }
        // Fader Level Control
        logWithTimestamp("Setting fader 1 to -20dB...");
        try {
            await timeoutWrapper(client.setFaderLevelDb(1, -20));
            logWithTimestamp("Set fader 1 to -20dB");
        }
        catch (error) {
            logWithTimestamp("Failed to set fader level:", error);
        }
        logWithTimestamp("Getting fader 1 level...");
        try {
            const faderLevel = await timeoutWrapper(client.getFaderLevel(1));
            const faderLevelDb = (0, index_1.channelLevelToDb)(faderLevel);
            logWithTimestamp(`Fader 1: Level ${faderLevel}, ${faderLevelDb.toFixed(1)}dB`);
        }
        catch (error) {
            logWithTimestamp("Failed to get fader level:", error);
        }
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
    }
    catch (error) {
        logWithTimestamp("Level 1 example failed:", error);
    }
}
// Protocol Level 20 Examples (Auxiliary send routing extensions)
async function runLevel20Examples(client) {
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
    }
    catch (error) {
        logWithTimestamp("Level 20 example failed:", error);
    }
}
// Protocol Level 21 Examples (Channel/Group routing to mains extensions)
async function runLevel21Examples(client) {
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
    }
    catch (error) {
        logWithTimestamp("Level 21 example failed:", error);
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
    const port = options.port || 3322;
    const level = options.level || "all";
    logWithTimestamp(`Starting Calrec CSCP examples (Level: ${level}, Host: ${host}:${port})`);
    const client = createClient(host, port);
    setupEventListeners(client);
    try {
        // Connect to the console
        logWithTimestamp("🔗 Connecting to Calrec console...");
        await client.connect();
        // Wait for client to be ready
        await new Promise((resolve) => {
            console.log("Waiting for client to be ready");
            client.once("ready", resolve);
            setTimeout(() => resolve(), 100);
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
            case "all":
            default:
                await runLevel1Examples(client);
                await runLevel20Examples(client);
                await runLevel21Examples(client);
                break;
        }
        logWithTimestamp("✅ All examples completed successfully!");
    }
    catch (error) {
        logWithTimestamp("❌ Examples failed:", error);
    }
    finally {
        // Cleanup
        logWithTimestamp("🧹 Cleaning up...");
        //await client.disconnect();
        logWithTimestamp("Cleanup complete");
        // Exit after a short delay
        /*setTimeout(() => {
            logWithTimestamp("Exiting...");
            //process.exit(0);
        
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
//# sourceMappingURL=examples.js.map