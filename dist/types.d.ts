/**
 * Enum for the client's connection state.
 */
export declare enum ConnectionState {
    DISCONNECTED = "disconnected",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    RECONNECTING = "reconnecting",
    ERROR = "error"
}
/**
 * Represents the complete state of the CalrecClient.
 */
export interface ClientState {
    connectionState: ConnectionState;
    consoleInfo: ConsoleInfo | null;
    consoleName: string | null;
}
/**
 * Configuration options for the CalrecClient.
 */
export interface CalrecClientOptions {
    host: string;
    port: number;
    /**
     * Whether the client should attempt to reconnect automatically after a disconnect.
     * @default true
     */
    autoReconnect?: boolean;
    /**
     * The delay in milliseconds before attempting to reconnect.
     * @default 5000
     */
    reconnectInterval?: number;
}
/**
 * Represents the structure of a parsed incoming message from the console.
 */
export interface ParsedMessage {
    command: number;
    data: Buffer;
}
/**
 * Enum for audio path types as defined in section 7.11.
 */
export declare enum AudioType {
    NO_AUDIO = 0,
    AUDIO_CHANNEL = 1,
    AUDIO_GROUP = 2,
    VCA_MASTER_WITHOUT_SLAVE = 3,
    VCA_MASTER_WITH_CHANNEL_SLAVE = 4,
    VCA_MASTER_WITH_GROUP_SLAVE = 5,
    MAIN = 6,
    VCA_MASTER_WITH_MAIN_SLAVE = 7,
    TRACK = 8,
    VCA_MASTER_WITH_TRACK_SLAVE = 9,
    AUX_OUTPUT = 10,
    VCA_MASTER_WITH_AUX_OUTPUT_SLAVE = 11
}
/**
 * Enum for audio path widths as defined in section 7.11.
 */
export declare enum AudioWidth {
    NO_AUDIO = 0,
    MONO = 1,
    STEREO = 2,
    SURROUND_5_1 = 6
}
/**
 * Represents the assignment of a fader, as per command 7.11.
 */
export interface FaderAssignment {
    faderId: number;
    type: AudioType;
    width: AudioWidth;
    calrecId: number;
}
/**
 * Represents information about the Calrec console, as per command 7.2.
 */
export interface ConsoleInfo {
    protocolVersion: number;
    maxFaders: number;
    maxMains: number;
    deskLabel: string;
}
/**
 * Represents the state of the Left-to-Both and Right-to-Both controls for a stereo fader.
 */
export interface StereoImage {
    leftToBoth: boolean;
    rightToBoth: boolean;
}
/**
 * Defines the event map for the CalrecClient's EventEmitter.
 * This provides type-safe event listening.
 */
export interface CalrecClientEvents {
    connect: () => void;
    disconnect: () => void;
    ready: () => void;
    error: (error: Error) => void;
    connectionStateChange: (state: ConnectionState) => void;
    unsolicitedMessage: (message: ParsedMessage) => void;
    faderLevelChange: (faderId: number, level: number) => void;
    faderCutChange: (faderId: number, isCut: boolean) => void;
    faderPflChange: (faderId: number, pflOn: boolean) => void;
    faderLabelChange: (faderId: number, label: string) => void;
    faderAssignmentChange: (assignment: FaderAssignment) => void;
    mainLevelChange: (mainId: number, level: number) => void;
    mainPflChange: (mainId: number, pflOn: boolean) => void;
    mainLabelChange: (mainId: number, label: string) => void;
    availableAuxesChange: (available: boolean[]) => void;
    auxRoutingChange: (auxId: number, routes: boolean[]) => void;
    auxOutputLevelChange: (auxId: number, level: number) => void;
    availableMainsChange: (available: boolean[]) => void;
    mainRoutingChange: (mainId: number, routes: boolean[]) => void;
    stereoImageChange: (faderId: number, image: StereoImage) => void;
}
/**
 * Defines NAK error codes from section 5.7.
 */
export declare enum NakError {
    COMMAND_NOT_SUPPORTED = 1,
    TIMEOUT = 2,
    UNDEFINED_ERROR = 4,
    INTERFACE_ERROR = 8,
    BYTE_COUNT_ERROR = 16,
    CHECKSUM_ERROR = 32,
    PROTOCOL_ERROR = 64
}
//# sourceMappingURL=types.d.ts.map