// src/types.ts

/**
 * Enum for the client's connection state.
 */
export enum ConnectionState {
	/** Client is not connected to the console */
	DISCONNECTED = "disconnected",
	/** Client is attempting to connect */
	CONNECTING = "connecting",
	/** Client is connected and ready */
	CONNECTED = "connected",
	/** Client is attempting to reconnect after a disconnect */
	RECONNECTING = "reconnecting",
	/** Client encountered an error */
	ERROR = "error",
}

/**
 * Represents the complete state of the CalrecClient.
 */
export interface ClientState {
	/** Current connection state */
	connectionState: ConnectionState;
	/** Information about the connected console, null if not connected */
	consoleInfo: ConsoleInfo | null;
	/** Name of the connected console, null if not connected */
	consoleName: string | null;
}

/**
 * Configuration options for the CalrecClient.
 */
export interface CalrecClientOptions {
	/** IP address or hostname of the Calrec console */
	host: string;
	/** TCP port number for the console connection */
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
	/**
	 * Maximum number of faders to expect from the console.
	 * Used for validation and optimization. Must be between 1 and 192.
	 */
	maxFaderCount: number;
	/**
	 * Maximum number of main outputs to expect from the console.
	 * Used for validation and optimization.
	 * @default 3
	 */
	maxMainCount?: number;
	/**
	 * Timeout in milliseconds for waiting for console info during initialization.
	 * @default 10000
	 */
	consoleInfoTimeoutMs?: number;
	/**
	 * Whether to enable debug logging.
	 * @default false
	 */
	debug?: boolean;
}

/**
 * Represents the structure of a parsed incoming message from the console.
 */
export interface ParsedMessage {
	/** The command code from the protocol */
	command: number;
	/** The data payload of the message */
	data: Buffer;
}

/**
 * Enum for audio path types as defined in section 7.11 of the protocol specification.
 */
export enum AudioType {
	/** No audio assigned */
	NO_AUDIO = 0,
	/** Audio channel */
	AUDIO_CHANNEL = 1,
	/** Audio group */
	AUDIO_GROUP = 2,
	/** VCA master without slave */
	VCA_MASTER_WITHOUT_SLAVE = 3,
	/** VCA master with channel slave */
	VCA_MASTER_WITH_CHANNEL_SLAVE = 4,
	/** VCA master with group slave */
	VCA_MASTER_WITH_GROUP_SLAVE = 5,
	/** Main output */
	MAIN = 6,
	/** VCA master with main slave */
	VCA_MASTER_WITH_MAIN_SLAVE = 7,
	/** Track output */
	TRACK = 8,
	/** VCA master with track slave */
	VCA_MASTER_WITH_TRACK_SLAVE = 9,
	/** Aux output */
	AUX_OUTPUT = 10,
	/** VCA master with aux output slave */
	VCA_MASTER_WITH_AUX_OUTPUT_SLAVE = 11,
}

/**
 * Enum for audio path widths as defined in section 7.11 of the protocol specification.
 */
export enum AudioWidth {
	/** No audio */
	NO_AUDIO = 0,
	/** Mono audio */
	MONO = 1,
	/** Stereo audio */
	STEREO = 2,
	/** 5.1 surround audio */
	SURROUND_5_1 = 6,
}

/**
 * Represents the assignment of a fader, as per command 7.11 of the protocol specification.
 */
export interface FaderAssignment {
	/** The fader ID */
	faderId: number;
	/** The audio type assigned to this fader */
	type: AudioType;
	/** The audio width (mono, stereo, etc.) */
	width: AudioWidth;
	/** The Calrec internal ID for this assignment */
	calrecId: number;
}

/**
 * Represents information about the Calrec console, as per command 7.2 of the protocol specification.
 */
export interface ConsoleInfo {
	/** Protocol version number */
	protocolVersion: number;
	/** Maximum number of faders supported */
	maxFaders: number;
	/** Maximum number of main outputs supported */
	maxMains: number;
	/** Console desk label/name */
	deskLabel: string;
}

/**
 * Represents the state of the Left-to-Both and Right-to-Both controls for a stereo fader.
 */
export interface StereoImage {
	/** Whether the left channel is routed to both outputs */
	leftToBoth: boolean;
	/** Whether the right channel is routed to both outputs */
	rightToBoth: boolean;
}

/**
 * Defines the event map for the CalrecClient's EventEmitter.
 * This provides type-safe event listening.
 */
export interface CalrecClientEvents {
	/** Emitted when the client connects to the console */
	connect: () => void;
	/** Emitted when the client disconnects from the console */
	disconnect: () => void;
	/** Emitted when the client is fully initialized and ready */
	ready: () => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
	/** Emitted when the connection state changes */
	connectionStateChange: (state: ConnectionState) => void;
	/** Emitted when an unsolicited message is received */
	unsolicitedMessage: (message: ParsedMessage) => void;

	// Fader Events
	/** Emitted when a fader level changes */
	faderLevelChange: (faderId: number, level: number) => void;
	/** Emitted when a fader cut state changes */
	faderCutChange: (faderId: number, isCut: boolean) => void;
	/** Emitted when a fader PFL state changes */
	faderPflChange: (faderId: number, pflOn: boolean) => void;
	/** Emitted when a fader label changes */
	faderLabelChange: (faderId: number, label: string) => void;
	/** Emitted when a fader assignment changes */
	faderAssignmentChange: (assignment: FaderAssignment) => void;

	// Main Fader Events
	/** Emitted when a main fader level changes */
	mainLevelChange: (mainId: number, level: number) => void;
	/** Emitted when a main fader PFL state changes */
	mainPflChange: (mainId: number, pflOn: boolean) => void;
	/** Emitted when a main fader label changes */
	mainLabelChange: (mainId: number, label: string) => void;

	// Aux Events
	/** Emitted when available aux buses change */
	availableAuxesChange: (available: boolean[]) => void;
	/** Emitted when aux routing changes */
	auxRoutingChange: (auxId: number, routes: boolean[]) => void;
	/** Emitted when an aux output level changes */
	auxOutputLevelChange: (auxId: number, level: number) => void;

	// Main Routing Events
	/** Emitted when available main buses change */
	availableMainsChange: (available: boolean[]) => void;
	/** Emitted when main routing changes */
	mainRoutingChange: (mainId: number, routes: boolean[]) => void;

	// Stereo Image Events
	/** Emitted when stereo image settings change */
	stereoImageChange: (faderId: number, image: StereoImage) => void;
}

/**
 * Defines NAK error codes from section 5.7 of the protocol specification.
 */
export enum NakError {
	/** Command is not supported by the console */
	COMMAND_NOT_SUPPORTED = 1 << 0,
	/** Command timed out */
	TIMEOUT = 1 << 1,
	/** Undefined error occurred */
	UNDEFINED_ERROR = 1 << 2,
	/** Interface error occurred */
	INTERFACE_ERROR = 1 << 3,
	/** Byte count error in the message */
	BYTE_COUNT_ERROR = 1 << 4,
	/** Checksum error in the message */
	CHECKSUM_ERROR = 1 << 5,
	/** Protocol error occurred */
	PROTOCOL_ERROR = 1 << 6,
}
