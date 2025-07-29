#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
// Helper function to add timestamps to console output
function _logWithTimestamp(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}
// Create a client instance with custom settings
function createClient(host, port) {
    return new index_1.CalrecClient({
        host,
        port,
        maxFaderCount: 1, // Configure for 42 faders
        maxMainCount: 1, // Configure for 3 mains
        autoReconnect: true,
        reconnectInterval: 500,
    });
}
// Main execution function
async function main() {
    const host = "172.27.27.218";
    const port = 3322;
    const client = createClient(host, port);
    client.on("ready", () => {
        console.log("Client is ready");
    });
    client.on("faderPflChange", (faderId, pfl) => {
        console.log(`Fader ${faderId} PFL changed to ${pfl}`);
    });
    await client.connect();
}
main();
//# sourceMappingURL=test.js.map