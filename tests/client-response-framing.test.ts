import * as net from "node:net";
import { CalrecClient } from "../src/client";
import { ACK, buildPacket, COMMANDS, NAK } from "../src/protocol";

const RESPONSE_TIMEOUT_MS = 200;

/** Console replies are addressed to the controller (device 255). */
function consoleReply(command: number, data: Buffer): Buffer {
	const packet = buildPacket(command, data);
	packet[2] = 255; // the device byte is not part of the checksum
	return packet;
}

/**
 * A fake console whose reply bytes are chosen per request, so a test can control
 * exactly how responses are framed on the wire.
 */
function createFakeConsole(
	replyFor: (command: number, data: Buffer) => Buffer | null,
): Promise<{ port: number; close: () => Promise<void> }> {
	const sockets: net.Socket[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		socket.on("data", (chunk) => {
			// Requests are SOH, byteCount, device, cmdMsb, cmdLsb, ...data, checksum
			const command = chunk.readUInt16BE(3);
			const data = chunk.subarray(5, chunk.length - 1);
			const reply = replyFor(command, data);
			if (reply && !socket.destroyed) socket.write(reply);
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as net.AddressInfo).port,
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
		{ commandResponseTimeoutMs: RESPONSE_TIMEOUT_MS, globalCommandRateMs: 1 },
	);
}

describe("CalrecClient response framing and correlation", () => {
	test("a response sharing a chunk with a leading ACK is still processed", async () => {
		const faderId = 2;
		const level = 700;
		const payload = Buffer.alloc(4);
		payload.writeUInt16BE(faderId, 0);
		payload.writeUInt16BE(level, 2);

		const console_ = await createFakeConsole((command) => {
			if (command !== COMMANDS.READ_FADER_LEVEL) return null;
			return Buffer.concat([
				Buffer.from([ACK]),
				consoleReply(COMMANDS.WRITE_FADER_LEVEL, payload),
			]);
		});
		const client = createClient(console_.port);
		client.on("error", () => undefined);
		await client.connect();

		try {
			await expect(client.getFaderLevel(faderId)).resolves.toBe(level);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("a stereo image response is matched to its request", async () => {
		const faderId = 1;
		const console_ = await createFakeConsole((command, data) => {
			if (command !== COMMANDS.READ_STEREO_IMAGE) return null;
			const payload = Buffer.from([data[0], data[1], 0x01, 0x00]);
			return consoleReply(COMMANDS.WRITE_STEREO_IMAGE, payload);
		});
		const client = createClient(console_.port);
		client.on("error", () => undefined);
		await client.connect();

		try {
			await expect(client.getStereoImage(faderId)).resolves.toEqual({
				leftToBoth: true,
				rightToBoth: false,
			});
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("each in-flight read is rejected by its own NAK", async () => {
		const console_ = await createFakeConsole((command) => {
			if (command !== COMMANDS.READ_FADER_LEVEL) return null;
			return Buffer.from([NAK, 0x01]); // Command Not Supported
		});
		const client = createClient(console_.port);
		client.on("error", () => undefined);
		await client.connect();

		try {
			const first = client.getFaderLevel(1);
			await new Promise((r) => setTimeout(r, 20));
			const second = client.getFaderLevel(1);

			// One NAK settles one waiter; the second command gets its own NAK.
			await expect(first).rejects.toThrow(/NAK/);
			await expect(second).rejects.toThrow(/NAK/);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});
});
