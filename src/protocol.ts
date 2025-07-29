// src/protocol.ts

// Constants from the protocol specification
export const SOH = 0xf1;
const DEVICE_ID_CONTROLLER = 255;
const DEVICE_ID_CALREC = 0;

// Protocol versions from documentation
export const PROTOCOL_VERSIONS = {
	VERSION_1: 1, // Ross Compatible
	VERSION_20: 20, // Version 1 + Auxiliary send routing extensions
	VERSION_21: 21, // Version 20 + Channel/Group routing to mains extensions
} as const;

// Command rate limits from documentation
export const COMMAND_RATE_LIMITS = {
	MAX_BURST_RATE: 3, // Maximum 3 messages per 20ms burst
	BURST_WINDOW_MS: 20, // 20ms burst window
	CONTINUOUS_FADER_RATE_MS: 6, // One fader command every 6ms for continuous streams
} as const;

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
 * Organized by read/write and protocol version support.
 */
export const COMMANDS = {
	// Read Commands (MSB=0) - All versions
	READ_FADER_LEVEL: 0x0000,
	READ_FADER_CUT: 0x0001,
	READ_MAIN_FADER_LEVEL: 0x0002,
	READ_FADER_PFL: 0x0005,
	READ_CONSOLE_NAME: 0x0007,
	READ_CONSOLE_INFO: 0x0008,
	READ_FADER_LABEL: 0x000b,
	READ_MAIN_PFL: 0x000c,
	READ_MAIN_FADER_LABEL: 0x000d,

	// Additional commands that may be sent by the console (not fully documented)
	READ_UNKNOWN_03: 0x0003,
	READ_UNKNOWN_04: 0x0004,
	READ_UNKNOWN_06: 0x0006,
	READ_UNKNOWN_09: 0x0009,
	READ_UNKNOWN_0A: 0x000a,
	READ_UNKNOWN_0E: 0x000e,
	READ_UNKNOWN_0F: 0x000f,

	// Write commands that may be sent by the console (not fully documented)
	WRITE_CONSOLE_NAME: 0x8007, // Response to READ_CONSOLE_NAME
	WRITE_FADER_LABEL: 0x800b, // Response to READ_FADER_LABEL
	WRITE_MAIN_FADER_LABEL: 0x800d, // Response to READ_MAIN_FADER_LABEL
	WRITE_CONSOLE_INFO: 0x8008, // Response to READ_CONSOLE_INFO

	// Read Commands - Version 20+ (Auxiliary send routing extensions)
	READ_AVAILABLE_AUX: 0x0010,
	READ_FADER_ASSIGNMENT: 0x0011,
	READ_AUX_SEND_ROUTING: 0x0012,
	READ_AUX_OUTPUT_LEVEL: 0x0013,

	// Read Commands - Version 21+ (Channel/Group routing to mains extensions)
	READ_AVAILABLE_MAINS: 0x0014,
	READ_STEREO_IMAGE: 0x0016,

	// Write Commands (MSB=1) - All versions
	WRITE_FADER_LEVEL: 0x8000,
	WRITE_FADER_CUT: 0x8001,
	WRITE_MAIN_FADER_LEVEL: 0x8002,
	WRITE_FADER_PFL: 0x8005,
	WRITE_MAIN_PFL: 0x800c,

	// Write Commands - Version 20+ (Auxiliary send routing extensions)
	WRITE_AUX_SEND_ROUTING: 0x8012,
	WRITE_AUX_OUTPUT_LEVEL: 0x8013,
	WRITE_AVAILABLE_AUX: 0x8010,
	WRITE_FADER_ASSIGNMENT: 0x8011,

	// Write Commands - Version 21+ (Channel/Group routing to mains extensions)
	WRITE_ROUTE_TO_MAIN: 0x8015,
	WRITE_STEREO_IMAGE: 0x8016,
	WRITE_AVAILABLE_MAINS: 0x8014,
} as const;

/**
 * Read-only commands that cannot be written to
 */
export const READ_ONLY_COMMANDS = new Set<number>([
	COMMANDS.READ_CONSOLE_NAME,
	COMMANDS.READ_CONSOLE_INFO,
	COMMANDS.READ_FADER_LABEL,
	COMMANDS.READ_MAIN_FADER_LABEL,
	COMMANDS.READ_AVAILABLE_AUX,
	COMMANDS.READ_FADER_ASSIGNMENT,
	COMMANDS.READ_AUX_SEND_ROUTING,
	COMMANDS.READ_AUX_OUTPUT_LEVEL,
	COMMANDS.READ_AVAILABLE_MAINS,
	COMMANDS.READ_STEREO_IMAGE,
	// Response commands from console (these are read-only from controller perspective)
	COMMANDS.WRITE_CONSOLE_NAME,
	COMMANDS.WRITE_FADER_LABEL,
	COMMANDS.WRITE_MAIN_FADER_LABEL,
	COMMANDS.WRITE_CONSOLE_INFO,
]);

/**
 * Commands that require protocol version 20 or higher
 */
export const VERSION_20_COMMANDS = new Set<number>([
	COMMANDS.READ_AVAILABLE_AUX,
	COMMANDS.READ_FADER_ASSIGNMENT,
	COMMANDS.READ_AUX_SEND_ROUTING,
	COMMANDS.WRITE_AUX_SEND_ROUTING,
	COMMANDS.READ_AUX_OUTPUT_LEVEL,
	COMMANDS.WRITE_AUX_OUTPUT_LEVEL,
	COMMANDS.WRITE_AVAILABLE_AUX,
	COMMANDS.WRITE_FADER_ASSIGNMENT,
]);

/**
 * Commands that require protocol version 21 or higher
 */
export const VERSION_21_COMMANDS = new Set<number>([
	COMMANDS.READ_AVAILABLE_MAINS,
	COMMANDS.WRITE_ROUTE_TO_MAIN,
	COMMANDS.READ_STEREO_IMAGE,
	COMMANDS.WRITE_STEREO_IMAGE,
	COMMANDS.WRITE_AVAILABLE_MAINS,
]);

/**
 * Check if a command is supported for the given protocol version
 */
export function isCommandSupported(
	command: number,
	protocolVersion: number,
): boolean {
	if (VERSION_21_COMMANDS.has(command)) {
		return protocolVersion >= PROTOCOL_VERSIONS.VERSION_21;
	}
	if (VERSION_20_COMMANDS.has(command)) {
		return protocolVersion >= PROTOCOL_VERSIONS.VERSION_20;
	}
	return true; // All other commands are supported in all versions
}

/**
 * Check if a command is read-only
 */
export function isReadOnlyCommand(command: number): boolean {
	return READ_ONLY_COMMANDS.has(command);
}

// Protocol constants
export const ACK = 0x04;
export const NAK = 0x05;
