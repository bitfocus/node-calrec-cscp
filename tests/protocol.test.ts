// tests/protocol.test.ts

import { ACK, buildPacket, COMMANDS, NAK, parsePacket } from "../src/protocol";

describe("📡 Protocol", () => {
	describe("buildPacket", () => {
		test("should build a valid packet with no data", () => {
			const packet = buildPacket(COMMANDS.READ_CONSOLE_INFO);

			expect(packet.length).toBe(6); // SOH + BC + DEV + CMD_MSB + CMD_LSB + CS
			expect(packet[0]).toBe(0xf1); // SOH
			expect(packet[1]).toBe(2); // Byte count (CMD only)
			expect(packet[2]).toBe(0); // Device ID (Calrec)
			expect(packet[3]).toBe(0x00); // CMD MSB
			expect(packet[4]).toBe(0x08); // CMD LSB
			// Checksum should be valid
		});

		test("should build a valid packet with data", () => {
			const data = Buffer.from([0x00, 0x01]); // Fader ID 1
			const packet = buildPacket(COMMANDS.READ_FADER_LEVEL, data);

			expect(packet.length).toBe(8); // SOH + BC + DEV + CMD_MSB + CMD_LSB + DATA + CS
			expect(packet[0]).toBe(0xf1); // SOH
			expect(packet[1]).toBe(4); // Byte count (CMD + DATA)
			expect(packet[2]).toBe(0); // Device ID (Calrec)
			expect(packet[3]).toBe(0x00); // CMD MSB
			expect(packet[4]).toBe(0x00); // CMD LSB
			expect(packet[5]).toBe(0x00); // Data byte 1
			expect(packet[6]).toBe(0x01); // Data byte 2
			// Checksum should be valid
		});

		test("should handle empty data buffer", () => {
			const packet = buildPacket(COMMANDS.READ_CONSOLE_NAME, Buffer.alloc(0));

			expect(packet.length).toBe(6);
			expect(packet[0]).toBe(0xf1); // SOH
			expect(packet[1]).toBe(2); // Byte count (CMD only)
		});
	});

	describe("parsePacket - Incoming from Console", () => {
		// Helper function to create a packet that would come from the console
		function createIncomingPacket(
			command: number,
			data: Buffer = Buffer.alloc(0),
		) {
			const byteCount = 2 + data.length;
			const cmdMsb = (command >> 8) & 0xff;
			const cmdLsb = command & 0xff;

			const cmdAndData = Buffer.concat([Buffer.from([cmdMsb, cmdLsb]), data]);
			let checksum = 0;
			for (const byte of cmdAndData) {
				checksum = (checksum + byte) & 0xff;
			}
			checksum = (~checksum + 1) & 0xff;

			return Buffer.concat([
				Buffer.from([byteCount, 255]), // BC, DEV (255 = controller)
				cmdAndData,
				Buffer.from([checksum]),
			]);
		}

		test("should parse a valid incoming packet with no data", () => {
			const packet = createIncomingPacket(COMMANDS.READ_CONSOLE_INFO);
			const parsed = parsePacket(packet);

			expect(parsed).not.toBeInstanceOf(Error);
			if (!(parsed instanceof Error)) {
				expect(parsed.command).toBe(COMMANDS.READ_CONSOLE_INFO);
				expect(parsed.data.length).toBe(0);
			}
		});

		test("should parse a valid incoming packet with data", () => {
			const data = Buffer.from([0x00, 0x01]);
			const packet = createIncomingPacket(COMMANDS.READ_FADER_LEVEL, data);
			const parsed = parsePacket(packet);

			expect(parsed).not.toBeInstanceOf(Error);
			if (!(parsed instanceof Error)) {
				expect(parsed.command).toBe(COMMANDS.READ_FADER_LEVEL);
				expect(parsed.data).toEqual(data);
			}
		});

		test("should reject incoming packet with wrong device ID", () => {
			const packet = Buffer.from([
				2, // Byte count
				1, // Wrong device ID (should be 255 for controller)
				0x00,
				0x08, // Command
				0x00, // Checksum
			]);

			const parsed = parsePacket(packet);
			expect(parsed).toBeInstanceOf(Error);
			if (parsed instanceof Error) {
				expect(parsed.message).toContain("incorrect device");
			}
		});

		test("should reject incoming packet with wrong byte count", () => {
			const packet = Buffer.from([
				5, // Wrong byte count
				255, // Device ID (controller)
				0x00,
				0x08, // Command
				0x00, // Checksum
			]);

			const parsed = parsePacket(packet);
			expect(parsed).toBeInstanceOf(Error);
			if (parsed instanceof Error) {
				expect(parsed.message).toContain("Byte count mismatch");
			}
		});

		test("should reject incoming packet with checksum error", () => {
			// Create a valid incoming packet first
			const validPacket = createIncomingPacket(COMMANDS.READ_CONSOLE_INFO);

			// Corrupt the checksum
			const corruptedPacket = Buffer.from(validPacket);
			corruptedPacket[corruptedPacket.length - 1] = 0xff; // Wrong checksum

			const parsed = parsePacket(corruptedPacket);
			expect(parsed).toBeInstanceOf(Error);
			if (parsed instanceof Error) {
				expect(parsed.message).toContain("Checksum error");
			}
		});

		test("should reject incoming packet that is too short", () => {
			const packet = Buffer.from([2, 255, 0x00]); // Too short

			const parsed = parsePacket(packet);
			expect(parsed).toBeInstanceOf(Error);
			if (parsed instanceof Error) {
				expect(parsed.message).toContain("too short");
			}
		});
	});

	describe("COMMANDS", () => {
		test("should have all required read commands", () => {
			expect(COMMANDS.READ_FADER_LEVEL).toBe(0x0000);
			expect(COMMANDS.READ_FADER_CUT).toBe(0x0001);
			expect(COMMANDS.READ_MAIN_FADER_LEVEL).toBe(0x0002);
			expect(COMMANDS.READ_FADER_PFL).toBe(0x0005);
			expect(COMMANDS.READ_CONSOLE_NAME).toBe(0x0007);
			expect(COMMANDS.READ_CONSOLE_INFO).toBe(0x0008);
			expect(COMMANDS.READ_FADER_LABEL).toBe(0x000b);
			expect(COMMANDS.READ_MAIN_PFL).toBe(0x000c);
			expect(COMMANDS.READ_MAIN_FADER_LABEL).toBe(0x000d);
			expect(COMMANDS.READ_AVAILABLE_AUX).toBe(0x0010);
			expect(COMMANDS.READ_FADER_ASSIGNMENT).toBe(0x0011);
			expect(COMMANDS.READ_AUX_SEND_ROUTING).toBe(0x0012);
			expect(COMMANDS.READ_AUX_OUTPUT_LEVEL).toBe(0x0013);
			expect(COMMANDS.READ_AVAILABLE_MAINS).toBe(0x0014);

			expect(COMMANDS.READ_STEREO_IMAGE).toBe(0x0016);
		});

		test("should have all required write commands", () => {
			expect(COMMANDS.WRITE_FADER_LEVEL).toBe(0x8000);
			expect(COMMANDS.WRITE_FADER_CUT).toBe(0x8001);
			expect(COMMANDS.WRITE_MAIN_FADER_LEVEL).toBe(0x8002);
			expect(COMMANDS.WRITE_FADER_PFL).toBe(0x8005);
			expect(COMMANDS.WRITE_MAIN_PFL).toBe(0x800c);
			expect(COMMANDS.WRITE_AUX_SEND_ROUTING).toBe(0x8012);
			expect(COMMANDS.WRITE_AUX_OUTPUT_LEVEL).toBe(0x8013);
			expect(COMMANDS.WRITE_ROUTE_TO_MAIN).toBe(0x8015);
			expect(COMMANDS.WRITE_STEREO_IMAGE).toBe(0x8016);
		});

		test("should have correct MSB for read vs write commands", () => {
			// Read commands should have MSB = 0
			expect(COMMANDS.READ_FADER_LEVEL & 0x8000).toBe(0);
			expect(COMMANDS.READ_CONSOLE_INFO & 0x8000).toBe(0);

			// Write commands should have MSB = 1
			expect(COMMANDS.WRITE_FADER_LEVEL & 0x8000).toBe(0x8000);
			expect(COMMANDS.WRITE_FADER_CUT & 0x8000).toBe(0x8000);
		});
	});

	describe("Protocol Constants", () => {
		test("should have correct ACK and NAK values", () => {
			expect(ACK).toBe(0x04);
			expect(NAK).toBe(0x05);
		});
	});

	describe("Packet Direction Tests", () => {
		test("should handle outgoing packets (to console)", () => {
			const testCommands = [
				{ command: COMMANDS.READ_CONSOLE_INFO, data: Buffer.alloc(0) },
				{ command: COMMANDS.READ_FADER_LEVEL, data: Buffer.from([0x00, 0x01]) },
				{
					command: COMMANDS.WRITE_FADER_LEVEL,
					data: Buffer.from([0x00, 0x01, 0x02, 0x00]),
				},
				{ command: COMMANDS.READ_FADER_LABEL, data: Buffer.from([0x00, 0x05]) },
			];

			testCommands.forEach(({ command, data }) => {
				const packet = buildPacket(command, data);

				// Verify packet structure for outgoing packets
				expect(packet[0]).toBe(0xf1); // SOH
				expect(packet[1]).toBe(2 + data.length); // Byte count
				expect(packet[2]).toBe(0); // Device ID (Calrec)
				expect(packet.length).toBe(6 + data.length); // SOH + BC + DEV + CMD + DATA + CS
			});
		});

		test("should handle incoming packets (from console)", () => {
			// Helper function to create incoming packets
			function createIncomingPacket(
				command: number,
				data: Buffer = Buffer.alloc(0),
			) {
				const byteCount = 2 + data.length;
				const cmdMsb = (command >> 8) & 0xff;
				const cmdLsb = command & 0xff;

				const cmdAndData = Buffer.concat([Buffer.from([cmdMsb, cmdLsb]), data]);
				let checksum = 0;
				for (const byte of cmdAndData) {
					checksum = (checksum + byte) & 0xff;
				}
				checksum = (~checksum + 1) & 0xff;

				return Buffer.concat([
					Buffer.from([byteCount, 255]), // BC, DEV (255 = controller)
					cmdAndData,
					Buffer.from([checksum]),
				]);
			}

			const testCommands = [
				{ command: COMMANDS.READ_FADER_LEVEL, data: Buffer.from([0x00, 0x01]) },
				{
					command: COMMANDS.WRITE_FADER_LEVEL,
					data: Buffer.from([0x00, 0x01, 0x02, 0x00]),
				},
				{ command: COMMANDS.READ_FADER_LABEL, data: Buffer.from([0x00, 0x05]) },
			];

			testCommands.forEach(({ command, data }) => {
				console.log("command", command);
				console.log("data", data);

				const packet = createIncomingPacket(command, data);
				const parsed = parsePacket(packet);

				expect(parsed).not.toBeInstanceOf(Error);
				if (!(parsed instanceof Error)) {
					expect(parsed.command).toBe(command);
					expect(parsed.data).toEqual(data);
				}
			});
		});
	});
});
