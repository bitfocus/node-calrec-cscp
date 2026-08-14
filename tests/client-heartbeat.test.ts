import * as net from "node:net";
import { CalrecClient } from "../src/client";
import { ACK } from "../src/protocol";
import { ConnectionState } from "../src/types";

/**
 * A console that accepts connections and, optionally, answers whatever it
 * receives. A silent server stands in for the case the heartbeat exists for: the
 * socket stays open while the console is no longer reachable.
 */
function createServer(options: { replyToData: boolean }): Promise<{
	port: number;
	pushByte: () => void;
	close: () => Promise<void>;
}> {
	const sockets: net.Socket[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
		if (options.replyToData) {
			socket.on("data", () => socket.write(Buffer.from([ACK])));
		}
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as net.AddressInfo).port,
				pushByte: () => {
					for (const socket of sockets) socket.write(Buffer.from([ACK]));
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
	return new CalrecClient(
		{
			host: "127.0.0.1",
			port,
			maxFaderCount: 8,
			autoReconnect: false,
		},
		{
			commandResponseTimeoutMs: 30,
			heartbeatIntervalMs: 40,
			heartbeatMaxMisses: 1,
		},
	);
}

describe("CalrecClient heartbeat", () => {
	test("a silent console is reported as an error and a disconnect", async () => {
		const server = await createServer({ replyToData: false });
		const client = createClient(server.port);
		const errors: Error[] = [];
		let disconnects = 0;
		client.on("error", (error) => errors.push(error));
		client.on("disconnect", () => {
			disconnects++;
		});

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			expect(errors.map((error) => error.message)).toContainEqual(
				expect.stringContaining("Console stopped responding"),
			);
			expect(disconnects).toBe(1);
			expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);
		} finally {
			await client.disconnect();
			await server.close();
		}
	});

	test("a silent console is reported even without an error listener", async () => {
		const server = await createServer({ replyToData: false });
		const client = createClient(server.port);
		let disconnects = 0;
		client.on("disconnect", () => {
			disconnects++;
		});

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			// An "error" event with no listener would have thrown out of the
			// heartbeat timer and taken the process with it.
			expect(disconnects).toBe(1);
			expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);
		} finally {
			await client.disconnect();
			await server.close();
		}
	});

	test("a console that answers the probe stays connected", async () => {
		const server = await createServer({ replyToData: true });
		const client = createClient(server.port);
		client.on("error", () => undefined);

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);
		} finally {
			await client.disconnect();
			await server.close();
		}
	});

	test("unsolicited console traffic alone keeps the connection alive", async () => {
		const server = await createServer({ replyToData: false });
		const client = createClient(server.port);
		client.on("error", () => undefined);
		const push = setInterval(() => server.pushByte(), 15);

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);
		} finally {
			clearInterval(push);
			await client.disconnect();
			await server.close();
		}
	});

	test("heartbeats can be disabled", async () => {
		const server = await createServer({ replyToData: false });
		const client = new CalrecClient(
			{
				host: "127.0.0.1",
				port: server.port,
				maxFaderCount: 8,
				autoReconnect: false,
			},
			{ commandResponseTimeoutMs: 30, heartbeatIntervalMs: 0 },
		);
		client.on("error", () => undefined);

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);
		} finally {
			await client.disconnect();
			await server.close();
		}
	});

	test("a lost connection is retried when auto-reconnect is enabled", async () => {
		const server = await createServer({ replyToData: false });
		const client = new CalrecClient(
			{
				host: "127.0.0.1",
				port: server.port,
				maxFaderCount: 8,
				autoReconnect: true,
				reconnectInterval: 30,
			},
			{
				commandResponseTimeoutMs: 30,
				heartbeatIntervalMs: 40,
				heartbeatMaxMisses: 1,
			},
		);
		const states: ConnectionState[] = [];
		client.on("error", () => undefined);
		client.on("connectionStateChange", (state) => states.push(state));

		try {
			await client.connect();
			await new Promise((r) => setTimeout(r, 300));

			expect(states).toContain(ConnectionState.RECONNECTING);
			// The silent server accepts again, so a reconnect must have succeeded.
			expect(
				states.filter((state) => state === ConnectionState.CONNECTED).length,
			).toBeGreaterThan(1);
		} finally {
			await client.disconnect();
			await server.close();
		}
	});
});
