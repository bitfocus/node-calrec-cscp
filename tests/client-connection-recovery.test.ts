import * as net from "node:net";
import { CalrecClient } from "../src/client";
import { ConnectionState } from "../src/types";

/** A port nothing listens on, so connecting to it always fails. */
async function findClosedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = server.address() as net.AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function createServer(): Promise<{
	port: number;
	close: () => Promise<void>;
	dropClients: () => void;
}> {
	const sockets: net.Socket[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => undefined);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as net.AddressInfo).port,
				dropClients: () => {
					for (const socket of sockets) socket.destroy();
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

describe("CalrecClient connection recovery", () => {
	test("a failed connect leaves the client able to connect again", async () => {
		const closedPort = await findClosedPort();
		const client = new CalrecClient({
			host: "127.0.0.1",
			port: closedPort,
			maxFaderCount: 8,
			autoReconnect: false,
		});
		client.on("error", () => undefined);

		await expect(client.connect()).rejects.toThrow();
		expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);

		// The second attempt must actually try again rather than silently no-op on
		// a socket left over from the failure.
		await expect(client.connect()).rejects.toThrow();

		const server = await createServer();
		try {
			const reachable = new CalrecClient({
				host: "127.0.0.1",
				port: server.port,
				maxFaderCount: 8,
				autoReconnect: false,
			});
			reachable.on("error", () => undefined);
			await reachable.connect();
			expect(reachable.getConnectionState()).toBe(ConnectionState.CONNECTED);
			await reachable.disconnect();
		} finally {
			await server.close();
		}
	});

	test("a connection attempt gives up instead of waiting for the OS", async () => {
		// TEST-NET-1 is documentation-only address space, so a SYN sent there is
		// dropped rather than refused: exactly the console-is-off-network case where
		// the OS would otherwise retry for over a minute.
		const client = new CalrecClient(
			{
				host: "192.0.2.1",
				port: 3322,
				maxFaderCount: 8,
				autoReconnect: false,
			},
			{ connectTimeoutMs: 100 },
		);
		client.on("error", () => undefined);

		const startedAt = Date.now();
		await expect(client.connect()).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);

		// The abandoned socket must not block a later attempt.
		await expect(client.connect()).rejects.toThrow();
	});

	test("a failed reconnect does not raise an unhandled rejection", async () => {
		const closedPort = await findClosedPort();
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandled);

		const client = new CalrecClient({
			host: "127.0.0.1",
			port: closedPort,
			maxFaderCount: 8,
			autoReconnect: true,
			reconnectInterval: 20,
		});
		client.on("error", () => undefined);

		try {
			await expect(client.connect()).rejects.toThrow();
			expect(client.getConnectionState()).toBe(ConnectionState.RECONNECTING);
			// Long enough for a couple of reconnect attempts to fail.
			await new Promise((r) => setTimeout(r, 120));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await client.disconnect();
		}
	});

	test("a dropped connection rejects in-flight reads and clears the queue", async () => {
		const server = await createServer();
		const client = new CalrecClient(
			{
				host: "127.0.0.1",
				port: server.port,
				maxFaderCount: 8,
				autoReconnect: false,
			},
			{ commandResponseTimeoutMs: 5000 },
		);
		client.on("error", () => undefined);
		await client.connect();
		// The server sees the connection a tick after connect() resolves.
		await new Promise((r) => setTimeout(r, 50));

		try {
			const pending = client.getFaderLevel(1);
			const settled = pending.then(
				() => "resolved",
				(error: Error) => error.message,
			);

			server.dropClients();

			// Rejection arrives from the disconnect, well inside the 5s read timeout.
			await expect(
				Promise.race([
					settled,
					new Promise((r) => setTimeout(() => r("still pending"), 1000)),
				]),
			).resolves.toContain("Connection closed");
		} finally {
			await client.disconnect();
			await server.close();
		}
	});
});
