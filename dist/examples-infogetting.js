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
// Create a client instance with custom settings
function createClient(host, port) {
    return new index_1.CalrecClient({
        host,
        port,
        maxFaderCount: 42, // Configure for 42 faders
        maxMainCount: 3, // Configure for 3 mains
        autoReconnect: true,
        reconnectInterval: 500,
        debug: false, // Set to true to enable debug logging
    }, {
        globalCommandRateMs: 10,
        faderLevelRateMs: 100,
        commandResponseTimeoutMs: 500,
        initializationTimeoutMs: 500,
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
        const activeRoutes = routes.filter((r) => r).length;
        logWithTimestamp(`Aux ${auxId} routing changed: ${activeRoutes} active routes`);
    });
    client.on("mainRoutingChange", (mainId, routes) => {
        const activeRoutes = routes.filter((r) => r).length;
        logWithTimestamp(`Main ${mainId} routing changed: ${activeRoutes} active routes`);
    });
    client.on("availableAuxesChange", (available) => {
        const count = available.filter((a) => a).length;
        logWithTimestamp(`Available auxes changed: ${count} auxes available`);
    });
    client.on("availableMainsChange", (available) => {
        const count = available.filter((a) => a).length;
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
// Main execution function
async function main() {
    const host = "172.27.27.218";
    const port = 3322;
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
        // Tests?
    }
    catch (error) {
        logWithTimestamp("❌ Examples failed:", error);
    }
    finally {
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
//# sourceMappingURL=examples-infogetting.js.map