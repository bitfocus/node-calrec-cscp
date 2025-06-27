// examples.ts
// Examples demonstrating decibel conversion functionality

import {
	CalrecClient,
	dbToChannelLevel,
	channelLevelToDb,
	dbToMainLevel,
	mainLevelToDb,
} from "./index";

async function demonstrateDecibelConversion() {
	console.log("=== Calrec CSCP Decibel Conversion Examples ===\n");

	// Example 1: Converting between protocol levels and decibels
	console.log("1. Protocol Level ↔ Decibel Conversion Examples:");
	console.log("   Channel Fader:");
	console.log(
		`   - Protocol level 512 → ${channelLevelToDb(512).toFixed(2)} dB`,
	);
	console.log(`   - -20 dB → Protocol level ${dbToChannelLevel(-20)}`);
	console.log(`   - 0 dB → Protocol level ${dbToChannelLevel(0)}`);
	console.log(`   - +10 dB → Protocol level ${dbToChannelLevel(10)}`);

	console.log("\n   Main Fader:");
	console.log(`   - Protocol level 512 → ${mainLevelToDb(512).toFixed(2)} dB`);
	console.log(`   - -20 dB → Protocol level ${dbToMainLevel(-20)}`);
	console.log(`   - 0 dB → Protocol level ${dbToMainLevel(0)}`);
	console.log(`   - -10 dB → Protocol level ${dbToMainLevel(-10)}`);

	// Example 2: Using the client with decibel methods
	console.log("\n2. Client API with Decibel Methods:");

	const client = new CalrecClient({
		host: "172.27.27.218", // Replace with your console IP
		port: 1337,
	});

	client.on("connect", async () => {
		try {
			// Set fader levels using decibels
			await client.setFaderLevelDb(1, -20); // Set channel fader 1 to -20 dB
			await client.setMainFaderLevelDb(1, -10); // Set main fader 1 to -10 dB

			// Read fader levels in decibels
			const channelDb = await client.getFaderLevelDb(1);

			const mainDb = await client.getMainFaderLevelDb(1);

			console.log(`   - Channel fader 1: ${channelDb.toFixed(2)} dB`);
			console.log(`   - Main fader 1: ${mainDb.toFixed(2)} dB`);

			// Compare with raw levels
			const channelRaw = await client.getFaderLevel(1);
			const mainRaw = await client.getFaderLevel(1);
			console.log(`   - Channel fader 1 (raw): ${channelRaw}`);
			console.log(`   - Main fader 1 (raw): ${mainRaw}`);
		} catch (error) {
			console.error("Error during decibel conversion test:", error);
		} finally {
			client.disconnect();
		}
	});

	client.on("error", (error) => {
		console.error("Client error:", error);
	});

	client.connect();
}

// Example 3: Common mixing scenarios
function demonstrateMixingScenarios() {
	console.log("\n3. Common Mixing Scenarios:");

	console.log("   Setting up a mix:");
	console.log(`   - Kick drum: ${dbToChannelLevel(-6).toFixed(0)} (${-6} dB)`);
	console.log(`   - Snare drum: ${dbToChannelLevel(-8).toFixed(0)} (${-8} dB)`);
	console.log(
		`   - Bass guitar: ${dbToChannelLevel(-12).toFixed(0)} (${-12} dB)`,
	);
	console.log(`   - Lead vocal: ${dbToChannelLevel(-3).toFixed(0)} (${-3} dB)`);
	console.log(`   - Main mix: ${dbToMainLevel(-6).toFixed(0)} (${-6} dB)`);

	console.log("\n   Fader positions:");
	console.log(`   - Unity gain (0 dB): ${dbToChannelLevel(0)}`);
	console.log(`   - -20 dB: ${dbToChannelLevel(-20)}`);
	console.log(`   - -40 dB: ${dbToChannelLevel(-40)}`);
	console.log(`   - -60 dB: ${dbToChannelLevel(-60)}`);
}

// Example 4: Real-world usage with event listeners
async function demonstrateRealWorldUsage() {
	console.log("\n4. Real-world Usage with Event Listeners:");

	const client = new CalrecClient({
		host: "172.27.27.218", // Replace with your console IP
		port: 1337,
	});

	client.on("connect", () => {
		console.log("✅ Connected to Calrec console!");
	});

	client.on("ready", async () => {
		try {
			const info = await client.getConsoleInfo();
			console.log(
				`Console Info: ${info.deskLabel}, Protocol v${info.protocolVersion}`,
			);

			// Set fader levels using decibels
			await client.setFaderLevelDb(1, -6); // Kick drum
			await client.setFaderLevelDb(2, -8); // Snare drum
			await client.setFaderLevelDb(3, -12); // Bass guitar
			await client.setFaderLevelDb(4, -3); // Lead vocal
			await client.setMainFaderLevelDb(1, -6); // Main mix

			console.log("Mix levels set using decibels!");
		} catch (error) {
			console.error("Error during setup:", error);
		}
	});

	// Listen for fader changes and display in decibels
	client.on("faderLevelChange", (faderId, level) => {
		const db = channelLevelToDb(level).toFixed(1);
		console.log(`Fader ${faderId} level changed to ${level} (~${db} dB)`);
	});

	client.on("faderCutChange", (faderId, isCut) => {
		console.log(`Fader ${faderId} is now ${isCut ? "CUT" : "ON"}`);
	});

	client.on("error", (error) => {
		console.error("🔥 An error occurred:", error.message);
	});

	client.on("disconnect", () => {
		console.log("🔌 Disconnected from Calrec console.");
	});

	client.connect();
}

// Run examples
if (require.main === module) {
	demonstrateDecibelConversion();
	demonstrateMixingScenarios();
	demonstrateRealWorldUsage();
}

export {
	demonstrateDecibelConversion,
	demonstrateMixingScenarios,
	demonstrateRealWorldUsage,
};
