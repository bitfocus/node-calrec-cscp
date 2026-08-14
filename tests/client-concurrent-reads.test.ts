import * as net from "node:net";
import { CalrecClient } from "../src/client";
import { buildPacket, COMMANDS, SOH } from "../src/protocol";

const RESPONSE_TIMEOUT_MS = 200;

/** Console replies are addressed to the controller (device 255). */
function consoleReply(command: number, data: Buffer): Buffer {
	const packet = buildPacket(command, data);
	packet[2] = 255; // the device byte is not part of the checksum
	return packet;
}

type FakeConsole = {
	port: number;
	/** Counts how many times each command number was received. */
	receivedCommands: Map<number, number>;
	close: () => Promise<void>;
};

/**
 * Walk a TCP chunk that may contain several CSCP requests back-to-back.
 * Each request is SOH, byteCount, device, cmdMsb, cmdLsb, ...data, checksum.
 */
function forEachRequest(
	chunk: Buffer,
	onRequest: (command: number, data: Buffer) => void,
): void {
	let offset = 0;
	while (offset < chunk.length) {
		const sohIndex = chunk.indexOf(SOH, offset);
		if (sohIndex === -1) return;
		if (chunk.length - sohIndex < 4) return;
		const byteCount = chunk[sohIndex + 1];
		const messageLength = byteCount + 4;
		if (chunk.length - sohIndex < messageLength) return;
		const command = chunk.readUInt16BE(sohIndex + 3);
		const data = chunk.subarray(sohIndex + 5, sohIndex + messageLength - 1);
		onRequest(command, data);
		offset = sohIndex + messageLength;
	}
}

/**
 * A fake console. When `replyDelayMs` is null it accepts commands and stays
 * silent.
 */
function createFakeConsole(
	replyFor: (command: number, data: Buffer) => Buffer | null,
	replyDelayMs: number | null,
): Promise<FakeConsole> {
	const sockets: net.Socket[] = [];
	const receivedCommands = new Map<number, number>();
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		socket.on("data", (chunk) => {
			forEachRequest(chunk, (command, data) => {
				receivedCommands.set(command, (receivedCommands.get(command) ?? 0) + 1);
				if (replyDelayMs === null) return;
				const reply = replyFor(command, data);
				if (!reply) return;
				setTimeout(() => {
					if (!socket.destroyed) socket.write(reply);
				}, replyDelayMs);
			});
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			resolve({
				port,
				receivedCommands,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => done());
					}),
			});
		});
	});
}

function createClient(port: number): CalrecClient {
	return new CalrecClient(
		{ host: "127.0.0.1", port, maxFaderCount: 16, autoReconnect: false },
		{
			commandResponseTimeoutMs: RESPONSE_TIMEOUT_MS,
			globalCommandRateMs: 1,
			heartbeatIntervalMs: 0,
		},
	);
}

/** Resolves to "pending" if the promise has not settled by the deadline. */
function settledWithin<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ status: "fulfilled" | "rejected" | "pending"; value?: T }> {
	const pending = new Promise<{ status: "pending" }>((resolve) =>
		setTimeout(() => resolve({ status: "pending" }), ms),
	);
	return Promise.race([
		promise.then(
			(value) => ({ status: "fulfilled" as const, value }),
			() => ({ status: "rejected" as const }),
		),
		pending,
	]);
}

describe("CalrecClient concurrent reads sharing a response key", () => {
	// The console info payload the client expects: version, maxFaders, maxMains.
	const consoleInfoPayload = Buffer.concat([
		Buffer.from([0x00, 0x15, 0x00, 0x20, 0x00, 0x03]),
		Buffer.alloc(14),
	]);

	test("both callers resolve when the console answers each request", async () => {
		const console_ = await createFakeConsole(
			() => consoleReply(COMMANDS.WRITE_CONSOLE_INFO, consoleInfoPayload),
			50,
		);
		const client = createClient(console_.port);
		await client.connect();
		// Let the post-connect session READ_CONSOLE_INFO settle first.
		await new Promise((r) => setTimeout(r, 80));
		console_.receivedCommands.clear();

		try {
			const first = client.getConsoleInfo();
			await new Promise((r) => setTimeout(r, 20));
			const second = client.getConsoleInfo();

			const results = await Promise.all([
				settledWithin(first, RESPONSE_TIMEOUT_MS * 4),
				settledWithin(second, RESPONSE_TIMEOUT_MS * 4),
			]);

			expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
			expect(results[0].value).toMatchObject({
				protocolVersion: 21,
				maxFaders: 32,
				maxMains: 3,
			});
			expect(results[1].value).toMatchObject({
				protocolVersion: 21,
				maxFaders: 32,
				maxMains: 3,
			});
			expect(console_.receivedCommands.get(COMMANDS.READ_CONSOLE_INFO)).toBe(2);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("both callers reject when the console stays silent", async () => {
		const console_ = await createFakeConsole(() => null, null);
		const client = createClient(console_.port);
		await client.connect();
		await new Promise((r) => setTimeout(r, 80));
		console_.receivedCommands.clear();

		try {
			const first = client.getConsoleInfo();
			await new Promise((r) => setTimeout(r, 20));
			const second = client.getConsoleInfo();

			const results = await Promise.all([
				settledWithin(first, RESPONSE_TIMEOUT_MS * 4),
				settledWithin(second, RESPONSE_TIMEOUT_MS * 4),
			]);

			expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
			expect(console_.receivedCommands.get(COMMANDS.READ_CONSOLE_INFO)).toBe(2);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("both callers resolve for reads keyed by fader id", async () => {
		const faderId = 3;
		const level = 512;
		const levelPayload = Buffer.alloc(4);
		levelPayload.writeUInt16BE(faderId, 0);
		levelPayload.writeUInt16BE(level, 2);

		const console_ = await createFakeConsole((command) => {
			if (command === COMMANDS.READ_FADER_LEVEL) {
				return consoleReply(COMMANDS.WRITE_FADER_LEVEL, levelPayload);
			}
			return consoleReply(COMMANDS.WRITE_CONSOLE_INFO, consoleInfoPayload);
		}, 50);
		const client = createClient(console_.port);
		await client.connect();

		try {
			const first = client.getFaderLevel(faderId);
			await new Promise((r) => setTimeout(r, 20));
			const second = client.getFaderLevel(faderId);

			const results = await Promise.all([
				settledWithin(first, RESPONSE_TIMEOUT_MS * 4),
				settledWithin(second, RESPONSE_TIMEOUT_MS * 4),
			]);

			expect(results).toEqual([
				{ status: "fulfilled", value: level },
				{ status: "fulfilled", value: level },
			]);
			expect(console_.receivedCommands.get(COMMANDS.READ_FADER_LEVEL)).toBe(2);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("a second WRITE reply does not emit spurious faderLevelChange", async () => {
		const faderId = 3;
		const level = 512;
		const levelPayload = Buffer.alloc(4);
		levelPayload.writeUInt16BE(faderId, 0);
		levelPayload.writeUInt16BE(level, 2);

		const console_ = await createFakeConsole((command) => {
			if (command === COMMANDS.READ_FADER_LEVEL) {
				return consoleReply(COMMANDS.WRITE_FADER_LEVEL, levelPayload);
			}
			return null;
		}, 50);
		const client = createClient(console_.port);
		await client.connect();

		const changeEvents: Array<[number, number]> = [];
		client.on("faderLevelChange", (id, value) => {
			changeEvents.push([id, value]);
		});

		try {
			const first = client.getFaderLevel(faderId);
			await new Promise((r) => setTimeout(r, 20));
			const second = client.getFaderLevel(faderId);

			await Promise.all([first, second]);

			// FIFO: each reply settles one waiter, so neither WRITE is treated as
			// an unsolicited console push.
			expect(console_.receivedCommands.get(COMMANDS.READ_FADER_LEVEL)).toBe(2);
			expect(changeEvents).toEqual([]);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});
});
