export declare const SOH = 241;
export declare const PROTOCOL_VERSIONS: {
    readonly VERSION_1: 1;
    readonly VERSION_20: 20;
    readonly VERSION_21: 21;
};
export declare const COMMAND_RATE_LIMITS: {
    readonly MAX_BURST_RATE: 3;
    readonly BURST_WINDOW_MS: 20;
    readonly CONTINUOUS_FADER_RATE_MS: 6;
};
/**
 * Builds a complete command packet to be sent to the Calrec console.
 * @param command The 2-byte command code.
 * @param data Optional data payload for the command.
 * @returns A Buffer ready to be written to the TCP socket.
 */
export declare function buildPacket(command: number, data?: Buffer): Buffer;
/**
 * Parses a raw buffer from the TCP stream into a structured message.
 * @param buffer The raw data buffer for a single message (without SOH).
 * @returns A structured message object or an Error if parsing fails.
 */
export declare function parsePacket(buffer: Buffer): {
    command: number;
    data: Buffer;
} | Error;
/**
 * All command codes from the specification document.
 * Organized by read/write and protocol version support.
 */
export declare const COMMANDS: {
    readonly READ_FADER_LEVEL: 0;
    readonly READ_FADER_CUT: 1;
    readonly READ_MAIN_FADER_LEVEL: 2;
    readonly READ_FADER_PFL: 5;
    readonly READ_CONSOLE_NAME: 7;
    readonly READ_CONSOLE_INFO: 8;
    readonly READ_FADER_LABEL: 11;
    readonly READ_MAIN_PFL: 12;
    readonly READ_MAIN_FADER_LABEL: 13;
    readonly READ_UNKNOWN_03: 3;
    readonly READ_UNKNOWN_04: 4;
    readonly READ_UNKNOWN_06: 6;
    readonly READ_UNKNOWN_09: 9;
    readonly READ_UNKNOWN_0A: 10;
    readonly READ_UNKNOWN_0E: 14;
    readonly READ_UNKNOWN_0F: 15;
    readonly READ_AVAILABLE_AUX: 16;
    readonly READ_FADER_ASSIGNMENT: 17;
    readonly READ_AUX_SEND_ROUTING: 18;
    readonly READ_AUX_OUTPUT_LEVEL: 19;
    readonly READ_AVAILABLE_MAINS: 20;
    readonly READ_ROUTE_TO_MAIN: 21;
    readonly READ_STEREO_IMAGE: 22;
    readonly WRITE_FADER_LEVEL: 32768;
    readonly WRITE_FADER_CUT: 32769;
    readonly WRITE_MAIN_FADER_LEVEL: 32770;
    readonly WRITE_FADER_PFL: 32773;
    readonly WRITE_MAIN_PFL: 32780;
    readonly WRITE_AUX_SEND_ROUTING: 32786;
    readonly WRITE_AUX_OUTPUT_LEVEL: 32787;
    readonly WRITE_AVAILABLE_AUX: 32784;
    readonly WRITE_FADER_ASSIGNMENT: 32785;
    readonly WRITE_ROUTE_TO_MAIN: 32789;
    readonly WRITE_STEREO_IMAGE: 32790;
    readonly WRITE_AVAILABLE_MAINS: 32788;
};
/**
 * Read-only commands that cannot be written to
 */
export declare const READ_ONLY_COMMANDS: Set<number>;
/**
 * Commands that require protocol version 20 or higher
 */
export declare const VERSION_20_COMMANDS: Set<number>;
/**
 * Commands that require protocol version 21 or higher
 */
export declare const VERSION_21_COMMANDS: Set<number>;
/**
 * Check if a command is supported for the given protocol version
 */
export declare function isCommandSupported(command: number, protocolVersion: number): boolean;
/**
 * Check if a command is read-only
 */
export declare function isReadOnlyCommand(command: number): boolean;
export declare const ACK = 4;
export declare const NAK = 5;
//# sourceMappingURL=protocol.d.ts.map