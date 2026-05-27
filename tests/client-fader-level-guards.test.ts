import { CalrecClient } from "../src/client";
import { ConnectionState, type CalrecClientOptions } from "../src/types";

describe("CalrecClient fader level guards", () => {
	const options: CalrecClientOptions = {
		host: "127.0.0.1",
		port: 3322,
		maxFaderCount: 16,
	};

	test("sends boundary levels but ignores out-of-range levels", async () => {
		const client = new CalrecClient(options);
		const sendCommandMock = jest.fn().mockResolvedValue(undefined);

		(client as unknown as { state: { connectionState: ConnectionState } }).state =
			{
				connectionState: ConnectionState.CONNECTED,
			} as { connectionState: ConnectionState };
		(
			client as unknown as {
				sendCommand: (command: number, data?: Buffer) => Promise<unknown>;
			}
		).sendCommand = sendCommandMock;

		await expect(client.setFaderLevel(0, -1)).resolves.toBeUndefined();
		await expect(client.setFaderLevel(0, 1024)).resolves.toBeUndefined();
		expect(sendCommandMock).toHaveBeenCalledTimes(0);

		await expect(client.setFaderLevel(0, 0)).resolves.toBeUndefined();
		await expect(client.setFaderLevel(0, 1023)).resolves.toBeUndefined();
		expect(sendCommandMock).toHaveBeenCalledTimes(2);
	});
});
