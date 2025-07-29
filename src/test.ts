#!/usr/bin/env node

import { CalrecClient } from "./index";

// Helper function to add timestamps to console output
function _logWithTimestamp(message: string, ...args: unknown[]) {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] ${message}`, ...args);
}

// Create a client instance with custom settings
function createClient(host: string, port: number): CalrecClient {
	return new CalrecClient({
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
