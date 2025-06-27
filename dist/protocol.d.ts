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
 */
export declare const COMMANDS: {
    READ_FADER_LEVEL: number;
    READ_FADER_CUT: number;
    READ_MAIN_FADER_LEVEL: number;
    READ_FADER_PFL: number;
    READ_CONSOLE_NAME: number;
    READ_CONSOLE_INFO: number;
    READ_FADER_LABEL: number;
    READ_MAIN_PFL: number;
    READ_MAIN_FADER_LABEL: number;
    READ_AVAILABLE_AUX: number;
    READ_FADER_ASSIGNMENT: number;
    READ_AUX_SEND_ROUTING: number;
    READ_AUX_OUTPUT_LEVEL: number;
    READ_AVAILABLE_MAINS: number;
    READ_ROUTE_TO_MAIN: number;
    READ_STEREO_IMAGE: number;
    WRITE_FADER_LEVEL: number;
    WRITE_FADER_CUT: number;
    WRITE_MAIN_FADER_LEVEL: number;
    WRITE_FADER_PFL: number;
    WRITE_MAIN_PFL: number;
    WRITE_AUX_SEND_ROUTING: number;
    WRITE_AUX_OUTPUT_LEVEL: number;
    WRITE_ROUTE_TO_MAIN: number;
    WRITE_STEREO_IMAGE: number;
};
export declare const ACK = 4;
export declare const NAK = 5;
//# sourceMappingURL=protocol.d.ts.map