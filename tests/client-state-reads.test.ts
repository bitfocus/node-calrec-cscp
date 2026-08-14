import * as net from "node:net";
import { CalrecClient } from "../src/client";
import { buildPacket, COMMANDS } from "../src/protocol";

/** Console replies are addressed to the controller (device 255). */
function consoleReply(command: number, data: Buffer): Buffer {
	const packet = buildPacket(command, data);
	packet[2] = 255; // the device byte is not part of the checksum
	return packet;
}

function createFakeConsole(
	replyFor: (command: number, data: Buffer) => Buffer | null,
): Promise<{
	port: number;
	push: (packet: Buffer) => void;
	close: () => Promise<void>;
}> {
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
				push: (packet) => {
					for (const socket of sockets) {
						if (!socket.destroyed) socket.write(packet);
					}
				},
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
	const client = new CalrecClient(
		{ host: "127.0.0.1", port, maxFaderCount: 16, autoReconnect: false },
		{ commandResponseTimeoutMs: 300, globalCommandRateMs: 1 },
	);
	client.on("error", () => undefined);
	return client;
}

/** Builds an id-prefixed one-byte state payload, as the console sends. */
function statePayload(id: number, state: number): Buffer {
	const payload = Buffer.alloc(3);
	payload.writeUInt16BE(id, 0);
	payload[2] = state;
	return payload;
}

describe("CalrecClient boolean state reads", () => {
	// 0 = cut and 1 = PFL on, per the protocol.
	const cases: [string, number, number, boolean][] = [
		["getFaderCut reports a cut fader", COMMANDS.READ_FADER_CUT, 0, true],
		["getFaderCut reports an open fader", COMMANDS.READ_FADER_CUT, 1, false],
		["getFaderPfl reports PFL on", COMMANDS.READ_FADER_PFL, 1, true],
		["getFaderPfl reports PFL off", COMMANDS.READ_FADER_PFL, 0, false],
		["getMainPfl reports PFL on", COMMANDS.READ_MAIN_PFL, 1, true],
		["getMainPfl reports PFL off", COMMANDS.READ_MAIN_PFL, 0, false],
	];

	test.each(cases)("%s", async (_name, readCommand, stateByte, expected) => {
		const id = 1;
		const console_ = await createFakeConsole((command, data) => {
			if (command !== readCommand) return null;
			const replyCommand = readCommand | 0x8000;
			return consoleReply(
				replyCommand,
				statePayload(data.readUInt16BE(0), stateByte),
			);
		});
		const client = createClient(console_.port);
		await client.connect();

		try {
			const read = {
				[COMMANDS.READ_FADER_CUT]: () => client.getFaderCut(id),
				[COMMANDS.READ_FADER_PFL]: () => client.getFaderPfl(id),
				[COMMANDS.READ_MAIN_PFL]: () => client.getMainPfl(id),
			}[readCommand];

			await expect(read?.()).resolves.toBe(expected);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("availability pushes are emitted as typed events", async () => {
		const console_ = await createFakeConsole(() => null);
		const client = createClient(console_.port);

		const auxes: boolean[][] = [];
		const mains: boolean[][] = [];
		client.on("availableAuxesChange", (available) => auxes.push(available));
		client.on("availableMainsChange", (available) => mains.push(available));

		await client.connect();
		await new Promise((r) => setTimeout(r, 50));

		try {
			// One byte per bus, low bit set when the bus exists.
			console_.push(
				consoleReply(
					COMMANDS.WRITE_AVAILABLE_AUX,
					Buffer.from([0x01, 0x01, 0x00, 0x01]),
				),
			);
			console_.push(
				consoleReply(
					COMMANDS.WRITE_AVAILABLE_MAINS,
					Buffer.from([0x01, 0x00, 0x01]),
				),
			);

			await new Promise((r) => setTimeout(r, 100));

			expect(auxes).toHaveLength(1);
			expect(auxes[0].slice(0, 4)).toEqual([true, true, false, true]);
			expect(auxes[0]).toHaveLength(32);
			expect(mains).toHaveLength(1);
			expect(mains[0].slice(0, 3)).toEqual([true, false, true]);
			expect(mains[0]).toHaveLength(16);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});

	test("label pushes are emitted as typed events", async () => {
		const console_ = await createFakeConsole(() => null);
		const client = createClient(console_.port);

		const faderLabels: [number, string][] = [];
		const mainLabels: [number, string][] = [];
		client.on("faderLabelChange", (id, label) => faderLabels.push([id, label]));
		client.on("mainLabelChange", (id, label) => mainLabels.push([id, label]));

		await client.connect();
		// The server sees the connection a tick after connect() resolves.
		await new Promise((r) => setTimeout(r, 50));

		try {
			const faderPayload = Buffer.concat([
				Buffer.from([0x00, 0x03]),
				Buffer.from("Group 1", "utf8"),
			]);
			const mainPayload = Buffer.concat([
				Buffer.from([0x00, 0x01]),
				Buffer.from("PGM2", "utf8"),
			]);
			console_.push(consoleReply(COMMANDS.WRITE_FADER_LABEL, faderPayload));
			console_.push(consoleReply(COMMANDS.WRITE_MAIN_FADER_LABEL, mainPayload));

			await new Promise((r) => setTimeout(r, 100));

			expect(faderLabels).toEqual([[3, "Group 1"]]);
			expect(mainLabels).toEqual([[1, "PGM2"]]);
		} finally {
			await client.disconnect();
			await console_.close();
		}
	});
});
