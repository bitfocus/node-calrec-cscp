"use strict";
// debug-example.ts
// Example script demonstrating hex debug logging for Calrec CSCP traffic
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
// Create a client instance
const client = new index_1.CalrecClient({
    host: "172.27.27.218", // Replace with your Calrec console IP
    port: 1337, // Replace with your configured TCP port
});
// Set up event listeners
client.on("connect", async () => {
    setTimeout(async () => {
        console.log("\n--- Testing Console Info ---");
        const info = await client.getConsoleInfo();
        console.log("Console info:", info.toString());
        console.log("\n--- Testing Console Name ---");
        const name = await client.getConsoleName();
        console.log("Console name:", name.toString());
        console.log("\n--- Testing Fader Level Read (Raw) ---");
        const level = await client.getFaderLevel(1);
        console.log("Fader 1 level (raw):", level);
        console.log("\n--- Testing Fader Level Read (dB) ---");
        const levelDb = await client.getFaderLevelDb(1);
        console.log("Fader 1 level (dB):", levelDb.toFixed(2) + " dB");
        console.log("\n--- Testing Fader Level Write (Raw) ---");
        await client.setFaderLevel(1, 512);
        console.log("Set fader 1 to raw level 512");
        console.log("\n--- Testing Fader Level Write (dB) ---");
        await client.setFaderLevelDb(1, -20);
        console.log("Set fader 1 to -20 dB");
        console.log("\n--- Testing Main Fader Level Write (dB) ---");
        await client.setMainFaderLevelDb(1, -10);
        console.log("Set main fader 1 to -10 dB");
        console.log("\n--- Testing Main Fader Level Read (dB) ---");
        const mainLevelDb = await client.getMainFaderLevelDb(1);
        console.log("Main fader 1 level (dB):", mainLevelDb.toFixed(2) + " dB");
    }, 1000);
});
client.on("ready", () => {
    console.log("🎯 Client is ready!");
});
client.on("error", (error) => {
    console.error("❌ Client error:", error);
});
client.on("disconnect", () => {
    console.log("🔌 Disconnected from console");
});
client.on("connectionStateChange", (state) => {
    console.log("🔄 Connection state changed to:", state);
});
// Connect to the console
console.log("🔗 Connecting to Calrec console...");
client.connect();
//# sourceMappingURL=debug-example.js.map