// src/protocol.ts

// Constants from the protocol specification
const SOH = 0xf1;
const DEVICE_ID_CONTROLLER = 255;
const DEVICE_ID_CALREC = 0;

/**
 * Calculates the 2's complement checksum for a buffer of command and data bytes.
 * @param buffer The buffer containing CMD and DATA.
 * @returns The 8-bit checksum value.
 */
function calculateChecksum(buffer: Buffer): number {
	let sum = 0;
	for (const byte of buffer) {
		sum = (sum + byte) & 0xff;
	}
	// 2's complement
	return (~sum + 1) & 0xff;
}

/**
 * Builds a complete command packet to be sent to the Calrec console.
 * @param command The 2-byte command code.
 * @param data Optional data payload for the command.
 * @returns A Buffer ready to be written to the TCP socket.
 */
export function buildPacket(
	command: number,
	data: Buffer = Buffer.alloc(0),
): Buffer {
	const byteCount = 2 + data.length; // CMD (2 bytes) + DATA
	const cmdMsb = (command >> 8) & 0xff;
	const cmdLsb = command & 0xff;

	const cmdAndData = Buffer.concat([Buffer.from([cmdMsb, cmdLsb]), data]);
	const checksum = calculateChecksum(cmdAndData);

	const header = Buffer.from([SOH, byteCount, DEVICE_ID_CALREC]);

	return Buffer.concat([header, cmdAndData, Buffer.from([checksum])]);
}

/**
 * Parses a raw buffer from the TCP stream into a structured message.
 * @param buffer The raw data buffer for a single message (without SOH).
 * @returns A structured message object or an Error if parsing fails.
 */
export function parsePacket(
	buffer: Buffer,
): { command: number; data: Buffer } | Error {
	const byteCount = buffer[0];
	const device = buffer[1];

	// Minimum length check (BC, DEV, CMD_MSB, CMD_LSB, CS)
	if (buffer.length < 5) return new Error("Packet too short");
	// Byte count check
	if (buffer.length !== byteCount + 3)
		return new Error(
			`Byte count mismatch. Expected ${byteCount + 3}, got ${buffer.length}`,
		);

	// Validate that the message is intended for this controller
	if (device !== DEVICE_ID_CONTROLLER) {
		// The Calrec desk should always send to device 255.
		// We can ignore messages not intended for us.
		return new Error(
			`Packet for incorrect device. Expected ${DEVICE_ID_CONTROLLER}, got ${device}`,
		);
	}

	const receivedChecksum = buffer[buffer.length - 1];
	const cmdAndData = buffer.slice(2, -1);
	const calculatedChecksum = calculateChecksum(cmdAndData);

	if (receivedChecksum !== calculatedChecksum) {
		return new Error(
			`Checksum error. Expected ${calculatedChecksum}, got ${receivedChecksum}`,
		);
	}

	const command = cmdAndData.readUInt16BE(0);
	const data = cmdAndData.slice(2);

	return { command, data };
}

/**
 * All command codes from the specification document.
 */
export const COMMANDS = {
	// Read Commands (MSB=0)
	READ_FADER_LEVEL: 0x0000,
	READ_FADER_CUT: 0x0001,
	READ_MAIN_FADER_LEVEL: 0x0002,
	READ_FADER_PFL: 0x0005,
	READ_CONSOLE_NAME: 0x0007,
	READ_CONSOLE_INFO: 0x0008,
	READ_FADER_LABEL: 0x000b,
	READ_MAIN_PFL: 0x000c,
	READ_MAIN_FADER_LABEL: 0x000d,
	READ_AVAILABLE_AUX: 0x0010,
	READ_FADER_ASSIGNMENT: 0x0011,
	READ_AUX_SEND_ROUTING: 0x0012,
	READ_AUX_OUTPUT_LEVEL: 0x0013,
	READ_AVAILABLE_MAINS: 0x0014,
	READ_ROUTE_TO_MAIN: 0x0015,
	READ_STEREO_IMAGE: 0x0016,

	// Write Commands (MSB=1)
	WRITE_FADER_LEVEL: 0x8000,
	WRITE_FADER_CUT: 0x8001,
	WRITE_MAIN_FADER_LEVEL: 0x8002,
	WRITE_FADER_PFL: 0x8005,
	WRITE_MAIN_PFL: 0x800c,
	WRITE_AUX_SEND_ROUTING: 0x8012,
	WRITE_AUX_OUTPUT_LEVEL: 0x8013,
	WRITE_ROUTE_TO_MAIN: 0x8015,
	WRITE_STEREO_IMAGE: 0x8016,
};

// Protocol constants
export const ACK = 0x04;
export const NAK = 0x05;
