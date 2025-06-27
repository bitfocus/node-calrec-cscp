/** biome-ignore-all assist/source/organizeImports: <explanation> */

import { CalrecClient, channelLevelToDb } from "./index";

let timer: NodeJS.Timeout;

// Create a client instance
const client = new CalrecClient({
	host: "172.27.27.218", // Replace with your Calrec console IP
	port: 1337, // Replace with your configured TCP port
});

// Set up event listeners
client.on("ready", async () => {
	console.log("ready");
	timer = setInterval(async () => {
		// ..
	}, 1000);
});

client.on('faderLevelChange', (faderId, level) => {
	console.log(`faderLevelChange: ${faderId}, ${level}, ${channelLevelToDb(level)}`);
});

client.on('faderLabelChange', (faderId, label) => {
	console.log(`faderLabelChange: ${faderId}, ${label}`);
});

client.on('faderAssignmentChange', (assignment) => {
	console.log(`faderAssignmentChange: ${assignment}`);
});

client.on('faderCutChange', (faderId, isCut) => {
	console.log(`faderCutChange: ${faderId}, ${isCut}`);
});

client.on('faderPflChange', (faderId, isPfl) => {
	console.log(`faderPflChange: ${faderId}, ${isPfl}`);
});

client.on('unsolicitedMessage', (message) => {
	console.log(`unsolicitedMessage: ${message.command}, ${message.data.toString('hex')}`);
});

client.on("connect", () => {
	console.log("✅ Connected to Calrec console!");
});

client.on("ready", () => {
	console.log("🎯 Client is ready!");
});

client.on("error", (error) => {
	console.error("❌ Client error:", error);
	clearInterval(timer);
});

client.on("disconnect", () => {
	console.log("🔌 Disconnected from console");
	clearInterval(timer);
});

client.on("connectionStateChange", (state) => {
	console.log("🔄 Connection state changed to:", state);
});

// Connect to the console
console.log("🔗 Connecting to Calrec console...");
client.connect();
