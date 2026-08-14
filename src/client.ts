// src/client.ts

import { EventEmitter } from "node:events";
import * as net from "node:net";
import {
	channelLevelToDb,
	dbToChannelLevel,
	dbToMainLevel,
	hexToString,
	mainLevelToDb,
} from "./converters";
import { ACK, buildPacket, COMMANDS, NAK, parsePacket, SOH } from "./protocol";
import {
	type CalrecClientEvents,
	type CalrecClientOptions,
	type ClientState,
	ConnectionState,
	type ConsoleInfo,
	type FaderAssignment,
	NakError,
	type ParsedMessage,
	type StereoImage,
} from "./types";

/**
 * Settings for protocol timing and behavior. All values are in milliseconds unless otherwise noted.
 */
export interface CalrecClientSettings {
	/** Minimum ms between any command (default: 10) */
	globalCommandRateMs?: number;
	/** Minimum ms between fader level commands (default: 100) */
	faderLevelRateMs?: number;
	/** Timeout for command responses (default: 20) */
	commandResponseTimeoutMs?: number;
	/** Timeout for initialization commands (console info/name) (default: 100) */
	initializationTimeoutMs?: number;
	/**
	 * How long a TCP connection attempt may take before it is abandoned
	 * (default: 5000). Without this the OS decides, which is around 75 seconds of
	 * SYN retries on an unreachable host — long enough to look like a hang.
	 */
	connectTimeoutMs?: number;
	/**
	 * How often an idle connection is probed to prove the console is still there
	 * (default: 5000). Set to 0 to disable heartbeats entirely.
	 */
	heartbeatIntervalMs?: number;
	/**
	 * Consecutive unanswered probes tolerated before the connection is treated as
	 * lost (default: 2). Worst-case detection time is
	 * `heartbeatIntervalMs * (heartbeatMaxMisses + 1)`.
	 */
	heartbeatMaxMisses?: number;
}

const DEFAULT_SETTINGS: Required<CalrecClientSettings> = {
	globalCommandRateMs: 10,
	faderLevelRateMs: 100,
	commandResponseTimeoutMs: 500,
	initializationTimeoutMs: 200,
	connectTimeoutMs: 5000,
	heartbeatIntervalMs: 5000,
	heartbeatMaxMisses: 2,
};

/**
 * Backstop for the application heartbeat: with keepalive on, the OS eventually
 * fails writes to a peer that has vanished instead of buffering them forever.
 */
const SOCKET_KEEPALIVE_DELAY_MS = 10000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: Error) => void;
	/** Set immediately after construction, so the handler can close over the request. */
	timeout?: NodeJS.Timeout;
}

/**
 * Commands whose payload does not begin with an id, so a request and its
 * response are correlated by command number alone.
 */
const NON_ID_SPECIFIC_COMMANDS = new Set<number>([
	COMMANDS.READ_CONSOLE_INFO,
	COMMANDS.READ_CONSOLE_NAME,
	COMMANDS.READ_AVAILABLE_AUX,
	COMMANDS.READ_AVAILABLE_MAINS,
]);

/**
 * Builds the key that correlates a request with its response. Both sides must
 * derive it the same way, so requests and responses share this one function.
 * @param command Either the read command or the write command the console
 * answers with; the write bit is masked off.
 * @param data The payload, whose first two bytes are the id for id-specific commands.
 */
function buildRequestKey(command: number, data: Buffer): string {
	const readCmd = command & 0x7fff;
	if (NON_ID_SPECIFIC_COMMANDS.has(readCmd) || data.length < 2) {
		return `${readCmd}`;
	}
	return `${readCmd}:${data.readUInt16BE(0)}`;
}

function parseNakError(errorCode: number): string {
	const errors: string[] = [];
	if (errorCode & NakError.COMMAND_NOT_SUPPORTED)
		errors.push("Command Not Supported");
	if (errorCode & NakError.TIMEOUT) errors.push("Timeout");
	if (errorCode & NakError.UNDEFINED_ERROR) errors.push("Undefined Error");
	if (errorCode & NakError.INTERFACE_ERROR) errors.push("Interface Error");
	if (errorCode & NakError.BYTE_COUNT_ERROR) errors.push("Byte Count Error");
	if (errorCode & NakError.CHECKSUM_ERROR) errors.push("Checksum Error");
	if (errorCode & NakError.PROTOCOL_ERROR) errors.push("Protocol Error");
	return `Received NAK with error(s): ${errors.join(", ") || "Unknown Error"}`;
}

export class CalrecClient extends EventEmitter {
	private options: CalrecClientOptions;
	private socket: net.Socket | null = null;
	private state: ClientState = {
		connectionState: ConnectionState.DISCONNECTED,
		consoleInfo: null,
		consoleName: null,
	};
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private dataBuffer: Buffer = Buffer.alloc(0);
	private commandQueue: {
		command: number;
		data: Buffer;
		resolve: (value: unknown) => void;
		reject: (reason?: Error) => void;
	}[] = [];
	private faderLevelQueue: {
		command: number;
		data: Buffer;
		resolve: (value: unknown) => void;
		reject: (reason?: Error) => void;
	}[] = [];
	private isProcessing = false;
	private lastFaderLevelSent = 0;
	private lastCommandSent = 0;
	private requestMap = new Map<string, PendingRequest[]>();
	private commandResponseQueue: Array<() => void> = [];
	private commandInFlight: boolean = false;
	private maxFaderCount?: number;
	private settings: Required<CalrecClientSettings>;
	private debug: boolean;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	/** When anything was last received; any byte proves the link is alive. */
	private lastRxAt = 0;
	private lastHeartbeatProbeAt: number | null = null;
	private missedHeartbeats = 0;

	constructor(
		options: CalrecClientOptions,
		settings: CalrecClientSettings = {},
	) {
		super();

		// Validate maxFaderCount
		if (options.maxFaderCount < 1 || options.maxFaderCount > 192) {
			throw new Error(
				`maxFaderCount must be between 1 and 192, got ${options.maxFaderCount}`,
			);
		}

		this.options = {
			autoReconnect: true,
			reconnectInterval: 5000,
			maxMainCount: 3, // Default to 3 mains
			debug: false,
			...options,
		};
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.debug = this.options.debug || false;
		this.setState({ connectionState: ConnectionState.DISCONNECTED });
	}

	/**
	 * Update protocol timing/settings at runtime.
	 * @param newSettings Partial settings to override current values.
	 */
	public updateSettings(newSettings: CalrecClientSettings) {
		this.settings = { ...this.settings, ...newSettings };
	}

	// Safely override EventEmitter methods with strong types
	on<K extends keyof CalrecClientEvents>(
		event: K,
		listener: CalrecClientEvents[K],
	): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}
	once<K extends keyof CalrecClientEvents>(
		event: K,
		listener: CalrecClientEvents[K],
	): this {
		return super.once(event, listener as (...args: unknown[]) => void);
	}
	emit<K extends keyof CalrecClientEvents>(
		event: K,
		...args: Parameters<CalrecClientEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}

	private setState(newState: Partial<ClientState>) {
		const oldState = { ...this.state };
		this.state = { ...this.state, ...newState };

		// Emit connection state change if it changed
		if (oldState.connectionState !== this.state.connectionState) {
			this.emit("connectionStateChange", this.state.connectionState);
		}
	}

	/**
	 * Connects to the Calrec console.
	 * @returns Promise that resolves when the connection is established and the client is ready.
	 */
	public async connect(): Promise<void> {
		if (
			this.socket ||
			this.state.connectionState === ConnectionState.CONNECTING
		) {
			this.debugWithTimestamp(
				`[CalrecClient] Connect called but already ${this.state.connectionState === ConnectionState.CONNECTING ? "connecting" : "connected"}`,
			);
			return;
		}

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		this.setState({
			connectionState: ConnectionState.CONNECTING,
			consoleInfo: null,
			consoleName: null,
		});

		const socket = new net.Socket();
		socket.setKeepAlive(true, SOCKET_KEEPALIVE_DELAY_MS);
		this.socket = socket;

		try {
			await new Promise<void>((resolve, reject) => {
				const handleConnectError = (err: Error) => {
					clearTimeout(connectTimeout);
					this.debugWithTimestamp(
						`[CalrecClient] Socket connection error: ${err.message}`,
					);
					reject(err);
				};
				// A host that is powered off or off-network answers nothing at all, and
				// the OS would keep retrying SYNs for over a minute before failing.
				const connectTimeout = setTimeout(() => {
					socket.off("error", handleConnectError);
					reject(
						new Error(
							`Timed out connecting to ${this.options.host}:${this.options.port} after ${this.settings.connectTimeoutMs}ms.`,
						),
					);
				}, this.settings.connectTimeoutMs);
				socket.once("error", handleConnectError);
				socket.connect(this.options.port, this.options.host, () => {
					clearTimeout(connectTimeout);
					socket.off("error", handleConnectError);
					this.debugWithTimestamp(
						`[CalrecClient] Socket connected to ${this.options.host}:${this.options.port}`,
					);
					resolve();
				});
			});
		} catch (error) {
			// Leave no half-open socket behind: it would make every later connect()
			// think a connection already exists and return without doing anything.
			socket.destroy();
			if (this.socket === socket) this.socket = null;
			this.setState({ connectionState: ConnectionState.DISCONNECTED });
			this.scheduleReconnect();
			throw error;
		}

		this.setState({ connectionState: ConnectionState.CONNECTED });
		this.lastRxAt = Date.now();
		this.startHeartbeat();
		this.emit("connect");
		// Start command queue processing immediately
		this.processCommandQueue();
		// Set up socket event handlers
		this.socket.on("data", this.handleData.bind(this));
		this.socket.on("close", this.handleDisconnect.bind(this));
		this.socket.on("error", (err) => {
			this.debugWithTimestamp(
				`[CalrecClient] Socket error after connection: ${err.message}`,
			);
			this.setState({ connectionState: ConnectionState.ERROR });
			this.emit("error", err);
		});

		// Emit ready event immediately since we don't need console info
		this.emit("ready");

		// Send a READ_CONSOLE_INFO command immediately to establish the session
		// The console might be expecting this to maintain the connection
		setTimeout(async () => {
			try {
				this.debugWithTimestamp(
					"[CalrecClient] Sending READ_CONSOLE_INFO to establish session...",
				);
				await this.getConsoleInfo();
				this.debugWithTimestamp(
					"[CalrecClient] READ_CONSOLE_INFO sent successfully",
				);
			} catch (error) {
				this.debugWithTimestamp(
					`[CalrecClient] READ_CONSOLE_INFO failed: ${error}`,
				);
			}
		}, 50); // Small delay to let the initial data flood complete
	}

	private handleDisconnect(): void {
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			// Drop our handlers before destroying, so the resulting close/error
			// events cannot re-enter this method with everything already torn down.
			socket.removeAllListeners();
			socket.on("error", () => undefined);
			socket.destroy();
		}
		this.stopHeartbeat();

		// Nothing queued can be sent or answered any more, and anything left behind
		// would be flushed as a stale command once a reconnect succeeds.
		this.dataBuffer = Buffer.alloc(0);
		this.commandQueue.length = 0;
		this.faderLevelQueue.length = 0;
		this.rejectAllPendingRequests(
			"Connection closed before a response arrived.",
		);

		this.emit("disconnect");

		if (this.state.connectionState !== ConnectionState.DISCONNECTED) {
			this.setState({
				connectionState: ConnectionState.DISCONNECTED,
				consoleInfo: null,
				consoleName: null,
			});
		}

		this.scheduleReconnect();
	}

	/**
	 * A console can vanish without the socket ever closing — a pulled cable, a
	 * dead switch or a dropped route leaves TCP with nothing to report, so the
	 * client would look connected indefinitely. Probing an idle link is the only
	 * way to notice.
	 */
	private startHeartbeat(): void {
		this.stopHeartbeat();
		if (this.settings.heartbeatIntervalMs <= 0) return;

		this.heartbeatTimer = setInterval(() => {
			this.checkHeartbeat();
		}, this.settings.heartbeatIntervalMs);
		// A heartbeat must not be a reason for the host process to stay alive.
		this.heartbeatTimer.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.lastHeartbeatProbeAt = null;
		this.missedHeartbeats = 0;
	}

	private checkHeartbeat(): void {
		if (
			this.state.connectionState !== ConnectionState.CONNECTED ||
			!this.socket
		) {
			return;
		}

		const now = Date.now();

		// The console pushes state changes constantly, so any recent traffic is
		// proof of life and a probe would only add noise.
		if (now - this.lastRxAt < this.settings.heartbeatIntervalMs) {
			this.lastHeartbeatProbeAt = null;
			this.missedHeartbeats = 0;
			return;
		}

		if (
			this.lastHeartbeatProbeAt !== null &&
			this.lastRxAt < this.lastHeartbeatProbeAt
		) {
			this.missedHeartbeats++;
			if (this.missedHeartbeats >= this.settings.heartbeatMaxMisses) {
				const error = new Error(
					`Console stopped responding: ${this.missedHeartbeats} heartbeat probe(s) unanswered, nothing received for ${now - this.lastRxAt}ms.`,
				);
				this.debugWithTimestamp(`[CalrecClient] ${error.message}`);
				// An unhandled "error" event would take the host process down from a
				// timer callback, and the disconnect below reports the loss anyway.
				if (this.listenerCount("error") > 0) this.emit("error", error);
				this.setState({ connectionState: ConnectionState.ERROR });
				this.handleDisconnect();
				return;
			}
		}

		this.lastHeartbeatProbeAt = now;
		// Console info is a cheap read every protocol version answers; the reply
		// content is irrelevant, only that something came back.
		this.getConsoleInfo().catch(() => undefined);
	}

	/** Starts the reconnect timer if auto-reconnect is enabled. */
	private scheduleReconnect(): void {
		if (!this.options.autoReconnect || this.reconnectTimeout) return;

		this.setState({ connectionState: ConnectionState.RECONNECTING });
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			// connect() rejects when the console is still down; that rejection has
			// no caller to catch it and would otherwise crash the process.
			this.connect().catch((error) => {
				this.debugWithTimestamp(
					`[CalrecClient] Reconnect attempt failed: ${error}`,
				);
			});
		}, this.options.reconnectInterval);
	}

	/**
	 * Disconnects from the Calrec console and disables auto-reconnect for this instance.
	 * @returns Promise that resolves when disconnected.
	 */
	public async disconnect(): Promise<void> {
		this.options.autoReconnect = false; // User-initiated disconnect should not reconnect
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.handleDisconnect();
	}

	private handleData(chunk: Buffer): void {
		this.lastRxAt = Date.now();
		this.debugWithTimestamp(
			`[CalrecClient] <<< RX HEX: ${chunk.toString("hex").toUpperCase()}`,
		);

		this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);

		// Debug: Log incoming data for troubleshooting
		if (this.dataBuffer.length > 0 && this.dataBuffer.length < 100) {
			/*this.debugWithTimestamp(
				`[CalrecClient] Buffer: ${this.dataBuffer.toString("hex")}`,
			);*/
		}

		// Process ACK/NAK bytes and complete packets. A single chunk can hold an
		// ACK/NAK followed by packets, so every branch either consumes bytes and
		// keeps looping or returns to wait for more data.
		while (this.dataBuffer.length > 0) {
			if (this.dataBuffer[0] === ACK) {
				this.debugWithTimestamp(
					`[CalrecClient] <<< RX: ACK (0x${ACK.toString(16)})`,
				);
				this.dataBuffer = this.dataBuffer.slice(1);
				continue;
			}
			if (this.dataBuffer[0] === NAK) {
				if (this.dataBuffer.length > 1) {
					const errorCode = this.dataBuffer[1];
					const errorMessage = parseNakError(errorCode);
					this.debugWithTimestamp(
						`[CalrecClient] <<< RX: NAK (0x${NAK.toString(16)}) - ${errorMessage} (code: ${errorCode})`,
					);
					this.rejectOldestPendingRequest(errorMessage);
					this.dataBuffer = this.dataBuffer.slice(2);
					continue;
				}
				// Debug: NAK without error code
				this.debugWithTimestamp(
					`[CalrecClient] <<< RX: NAK (0x${NAK.toString(16)}) without error code. Buffer: ${this.dataBuffer.toString("hex").toUpperCase()}`,
				);
				this.dataBuffer = this.dataBuffer.slice(1);
				continue;
			}

			const sohIndex = this.dataBuffer.indexOf(SOH);
			if (sohIndex === -1) {
				// No SOH found, wait for more data
				// But if we have a lot of data without SOH, something might be wrong
				if (this.dataBuffer.length > 100) {
					this.debugWithTimestamp(
						`[CalrecClient] No SOH found in buffer after 100+ bytes. Buffer: ${this.dataBuffer.toString("hex")}`,
					);
					// Try to find any potential packet start
					const potentialStart = this.dataBuffer.indexOf(0xf1);
					if (potentialStart !== -1) {
						this.debugWithTimestamp(
							`[CalrecClient] Found potential start at ${potentialStart}: 0xf1`,
						);
					}
				}
				return;
			}

			// Remove any data before SOH
			if (sohIndex > 0) {
				this.debugWithTimestamp(
					`[CalrecClient] Data before SOH: ${this.dataBuffer.slice(0, sohIndex).toString("hex")}`,
				);
				this.dataBuffer = this.dataBuffer.slice(sohIndex);
			}

			// Need at least 4 bytes: SOH, BC, DEV, CMD_MSB
			if (this.dataBuffer.length < 4) return;

			const byteCount = this.dataBuffer[1];
			const messageLength = byteCount + 4; // SOH + BC + DEV + CMD + DATA + CS

			if (this.dataBuffer.length < messageLength) return;

			const packetWithSoh = this.dataBuffer.slice(0, messageLength);
			const messageBufferForParser = packetWithSoh.slice(1); // Remove SOH

			this.debugWithTimestamp(
				`[CalrecClient] <<< RX: Processing packet HEX: ${packetWithSoh.toString("hex").toUpperCase()}`,
			);

			this.dataBuffer = this.dataBuffer.slice(messageLength);

			const parsed = parsePacket(messageBufferForParser);

			if (parsed instanceof Error) {
				this.debugWithTimestamp(
					`[CalrecClient] Failed to parse packet: ${parsed.message}. Raw data: ${messageBufferForParser.toString("hex")}`,
				);
				this.emit("error", parsed);
			} else {
				this.processIncomingMessage(parsed);
			}
		}
	}

	private processIncomingMessage(message: ParsedMessage): void {
		const { command, data } = message;

		const requestKey = buildRequestKey(command, data);

		const pendingRequest = this.takeOldestPendingRequest(requestKey);
		if (pendingRequest) {
			// One reply settles one waiter. Settling every waiter on the key would
			// leave any further replies for the same key looking unsolicited, which
			// spuriously emits change events (e.g. faderLevelChange).
			pendingRequest.resolve(this.parseResponseData(command, data));
			return;
		}

		// If no pending request found, this is an unsolicited message
		// We'll handle it in emitUnsolicitedEvent, so no need to log here

		this.emitUnsolicitedEvent(command, data);
	}

	private parseResponseData(command: number, data: Buffer): unknown {
		const readCmd = command & 0x7fff;
		const writeCommand = command | 0x8000;

		// Handle read commands first
		switch (readCmd) {
			case COMMANDS.READ_CONSOLE_NAME:
				try {
					// Convert hex data to string (e.g., "4d43533a31" -> "MCS:1")
					const hexData = data.toString("hex");
					const name = hexToString(hexData);
					this.debugWithTimestamp(
						`[CalrecClient] Parsed console name: "${name}" from hex: ${hexData}`,
					);
					return name || "Unknown";
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse console name: ${error}, data: ${data.toString("hex")}`,
					);
					return "Unknown";
				}
			case COMMANDS.READ_FADER_LABEL:
			case COMMANDS.READ_MAIN_FADER_LABEL:
				try {
					// Convert hex data to string (e.g., "00004c20314620203141" -> "L 1F  1A")
					const hexData = data.slice(2).toString("hex");
					const label = hexToString(hexData);
					this.debugWithTimestamp(
						`[CalrecClient] Parsed ${readCmd === COMMANDS.READ_FADER_LABEL ? "fader" : "main fader"} label: "${label}" from hex: ${hexData}`,
					);
					return label || "";
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse ${readCmd === COMMANDS.READ_FADER_LABEL ? "fader" : "main fader"} label: ${error}, data: ${data.slice(2).toString("hex")}`,
					);
					return "";
				}
			case COMMANDS.READ_CONSOLE_INFO:
				// Data for console info doesn't start with the ID, so we parse from the beginning
				try {
					this.debugWithTimestamp(
						`[CalrecClient] Parsing console info data: ${data.toString("hex")}, length: ${data.length}`,
					);

					if (data.length < 20) {
						this.debugWithTimestamp(
							`[CalrecClient] Console info data too short: ${data.length} bytes, expected at least 20`,
						);
						return {
							protocolVersion: 1, // Default to version 1
							maxFaders: this.getEffectiveMaxFaderCount(), // Use configured max fader count
							maxMains: this.getEffectiveMaxMainCount(), // Use configured max main count
							deskLabel: "Unknown",
						} as ConsoleInfo;
					}

					const protocolVersion = data.readUInt16BE(0);
					const maxFaders = data.readUInt16BE(2);
					const maxMains = data.readUInt16BE(4);
					// Convert hex data to string for deskLabel (e.g., "4d43533a31000000" -> "MCS:1")
					const deskLabelHex = data.slice(12, 20).toString("hex");
					const deskLabel = hexToString(deskLabelHex);

					this.debugWithTimestamp(
						`[CalrecClient] Parsed console info: version=${protocolVersion}, faders=${maxFaders}, mains=${maxMains}, label="${deskLabel}"`,
					);

					return {
						updatedAt: new Date(),
						protocolVersion,
						maxFaders,
						maxMains,
						deskLabel: deskLabel || "Unknown",
					} as ConsoleInfo;
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse console info: ${error}, data: ${data.toString("hex")}`,
					);
					return {
						protocolVersion: 1,
						maxFaders: this.getEffectiveMaxFaderCount(),
						maxMains: this.getEffectiveMaxMainCount(),
						deskLabel: "Unknown",
					} as ConsoleInfo;
				}
			case COMMANDS.READ_FADER_LEVEL:
				return data.readUInt16BE(2);
			case COMMANDS.READ_FADER_ASSIGNMENT:
				try {
					if (data.length < 6) {
						this.debugWithTimestamp(
							`[CalrecClient] Fader assignment data too short: ${data.length} bytes, expected at least 6`,
						);
						return {
							faderId: 0,
							type: 0,
							width: 0,
							calrecId: 0,
						} as FaderAssignment;
					}

					const faderId = data.readUInt16BE(0);
					const type = data[2];
					const width = data[3];
					const calrecId = data.readUInt16BE(4);

					this.debugWithTimestamp(
						`[CalrecClient] Parsed fader assignment: faderId=${faderId}, type=${type}, width=${width}, calrecId=${calrecId}`,
					);

					return {
						faderId,
						type,
						width,
						calrecId,
					} as FaderAssignment;
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse fader assignment: ${error}, data: ${data.toString("hex")}`,
					);
					return {
						faderId: 0,
						type: 0,
						width: 0,
						calrecId: 0,
					} as FaderAssignment;
				}
			case COMMANDS.READ_STEREO_IMAGE:
				try {
					if (data.length >= 4) {
						return {
							leftToBoth: !!data[2],
							rightToBoth: !!data[3],
						} as StereoImage;
					}
					throw new Error("Stereo image data too short");
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse stereo image: ${error}, data: ${data.toString("hex")}`,
					);
					return {
						leftToBoth: false,
						rightToBoth: false,
					} as StereoImage;
				}
			case COMMANDS.READ_FADER_CUT:
				return data[2] === 0; // 0 = cut, 1 = uncut
			case COMMANDS.READ_FADER_PFL:
				return data[2] === 1; // 1 = PFL on, 0 = PFL off
			case COMMANDS.READ_MAIN_PFL:
				return data[2] === 1; // 1 = PFL on, 0 = PFL off
			case COMMANDS.READ_AVAILABLE_AUX:
				try {
					const available = new Array(32).fill(false);
					for (let i = 0; i < Math.min(data.length, 32); i++) {
						available[i] = (data[i] & 0x01) !== 0;
					}
					return available;
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse available aux: ${error}, data: ${data.toString("hex")}`,
					);
					return new Array(32).fill(false);
				}
			case COMMANDS.READ_AVAILABLE_MAINS:
				try {
					const available = new Array(16).fill(false);
					for (let i = 0; i < Math.min(data.length, 16); i++) {
						available[i] = (data[i] & 0x01) !== 0;
					}
					return available;
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse available mains: ${error}, data: ${data.toString("hex")}`,
					);
					return new Array(16).fill(false);
				}
			case COMMANDS.READ_AUX_SEND_ROUTING:
				try {
					const maxFaders = this.getEffectiveMaxFaderCount();
					const routes = new Array(maxFaders).fill(false);
					for (
						let byteIndex = 0;
						byteIndex < Math.min(data.length, Math.ceil(maxFaders / 8));
						byteIndex++
					) {
						const byte = data[byteIndex];
						for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
							const faderIndex = byteIndex * 8 + bitIndex;
							if (faderIndex < maxFaders) {
								routes[faderIndex] = (byte & (1 << bitIndex)) !== 0;
							}
						}
					}
					return routes;
				} catch (error) {
					this.debugWithTimestamp(
						`[CalrecClient] Failed to parse aux send routing: ${error}, data: ${data.toString("hex")}`,
					);
					return new Array(this.getEffectiveMaxFaderCount()).fill(false);
				}
		}

		// Handle write commands
		switch (writeCommand) {
			case COMMANDS.WRITE_FADER_LEVEL:
			case COMMANDS.WRITE_AUX_OUTPUT_LEVEL:
				return data.readUInt16BE(2);
			case COMMANDS.WRITE_FADER_CUT:
				return data[2] === 0;
			case COMMANDS.WRITE_FADER_PFL:
			case COMMANDS.WRITE_MAIN_PFL:
				return data[2] === 1;
			default:
				this.debugWithTimestamp(
					`[CalrecClient] Unhandled response data for command: ${command.toString(16)}`,
				);
				return data;
		}
	}

	private emitUnsolicitedEvent(command: number, data: Buffer): void {
		// Check if this is a write command (MSB set)
		const isWriteCommand = (command & 0x8000) !== 0;
		const baseCommand = command & 0x7fff;

		this.debugWithTimestamp(
			`[CalrecClient] Processing unsolicited event: command=0x${command.toString(16)}, baseCommand=0x${baseCommand.toString(16)}, data=${data.toString("hex")}`,
		);

		// Handle write commands that are unsolicited responses
		if (isWriteCommand) {
			// These are write command responses - process them as actual changes
			switch (baseCommand) {
				case COMMANDS.READ_FADER_LEVEL: // 0x0000 -> WRITE_FADER_LEVEL: 0x8000
					if (data.length >= 4) {
						const faderId = data.readUInt16BE(0);
						const level = data.readUInt16BE(2);
						this.debugWithTimestamp(
							`[CalrecClient] Emitting faderLevelChange: faderId=${faderId}, level=${level}`,
						);
						this.emit("faderLevelChange", faderId, level);
					}
					break;
				case COMMANDS.READ_MAIN_FADER_LEVEL: // 0x0002 -> WRITE_MAIN_FADER_LEVEL: 0x8002
					if (data.length >= 4) {
						const mainId = data.readUInt16BE(0);
						const level = data.readUInt16BE(2);
						this.debugWithTimestamp(
							`[CalrecClient] Emitting mainLevelChange: mainId=${mainId}, level=${level}`,
						);
						this.emit("mainLevelChange", mainId, level);
					}
					break;
				case COMMANDS.READ_FADER_CUT: // 0x0001 -> WRITE_FADER_CUT: 0x8001
					if (data.length >= 3) {
						const faderId = data.readUInt16BE(0);
						const isCut = data[2] === 0; // 0 = cut, 1 = uncut
						this.debugWithTimestamp(
							`[CalrecClient] Emitting faderCutChange: faderId=${faderId}, isCut=${isCut}`,
						);
						this.emit("faderCutChange", faderId, isCut);
					}
					break;
				case COMMANDS.READ_FADER_PFL: // 0x0005 -> WRITE_FADER_PFL: 0x8005
					if (data.length >= 3) {
						const faderId = data.readUInt16BE(0);
						const isPfl = data[2] === 1; // 1 = PFL on, 0 = PFL off
						this.debugWithTimestamp(
							`[CalrecClient] Emitting faderPflChange: faderId=${faderId}, isPfl=${isPfl}`,
						);
						this.emit("faderPflChange", faderId, isPfl);
					}
					break;
				case COMMANDS.READ_MAIN_PFL: // 0x000c -> WRITE_MAIN_PFL: 0x800c
					if (data.length >= 3) {
						const mainId = data.readUInt16BE(0);
						const isPfl = data[2] === 1; // 1 = PFL on, 0 = PFL off
						this.debugWithTimestamp(
							`[CalrecClient] Emitting mainPflChange: mainId=${mainId}, isPfl=${isPfl}`,
						);
						this.emit("mainPflChange", mainId, isPfl);
					}
					break;
				case COMMANDS.READ_AUX_OUTPUT_LEVEL: // 0x0013 -> WRITE_AUX_OUTPUT_LEVEL: 0x8013
					if (data.length >= 4) {
						const auxId = data.readUInt16BE(0);
						const level = data.readUInt16BE(2);
						this.debugWithTimestamp(
							`[CalrecClient] Emitting auxOutputLevelChange: auxId=${auxId}, level=${level}`,
						);
						this.emit("auxOutputLevelChange", auxId, level);
					}
					break;
				case COMMANDS.READ_FADER_LABEL: // 0x000b -> WRITE_FADER_LABEL: 0x800b
					if (data.length >= 2) {
						const faderId = data.readUInt16BE(0);
						const label = this.parseResponseData(command, data) as string;
						this.debugWithTimestamp(
							`[CalrecClient] Emitting faderLabelChange: faderId=${faderId}, label="${label}"`,
						);
						this.emit("faderLabelChange", faderId, label);
					}
					break;
				case COMMANDS.READ_MAIN_FADER_LABEL: // 0x000d -> WRITE_MAIN_FADER_LABEL: 0x800d
					if (data.length >= 2) {
						const mainId = data.readUInt16BE(0);
						const label = this.parseResponseData(command, data) as string;
						this.debugWithTimestamp(
							`[CalrecClient] Emitting mainLabelChange: mainId=${mainId}, label="${label}"`,
						);
						this.emit("mainLabelChange", mainId, label);
					}
					break;
				case COMMANDS.READ_AVAILABLE_AUX: // 0x0010 -> WRITE_AVAILABLE_AUX: 0x8010
				case COMMANDS.READ_AVAILABLE_MAINS: // 0x0014 -> WRITE_AVAILABLE_MAINS: 0x8014
					this.emitAvailableChange(baseCommand, data);
					break;
				default:
					// For other write commands, just emit as unsolicited message
					this.emit("unsolicitedMessage", { command, data });
					break;
			}
			return;
		}

		switch (baseCommand) {
			case COMMANDS.READ_CONSOLE_NAME:
			case COMMANDS.READ_CONSOLE_INFO:
				// These are expected unsolicited messages - parse and cache them
				if (baseCommand === COMMANDS.READ_CONSOLE_INFO) {
					const consoleInfo = this.parseResponseData(
						baseCommand,
						data,
					) as ConsoleInfo;
					this.debugWithTimestamp(
						`[CalrecClient] Received unsolicited console info:`,
						consoleInfo,
					);
					this.setState({ consoleInfo });
				} else if (baseCommand === COMMANDS.READ_CONSOLE_NAME) {
					const consoleName = this.parseResponseData(
						baseCommand,
						data,
					) as string;
					this.debugWithTimestamp(
						`[CalrecClient] Received unsolicited console name:`,
						consoleName,
					);
					this.setState({ consoleName });
				}
				break;
			case COMMANDS.READ_MAIN_FADER_LEVEL:
				// Handle unsolicited main fader level changes
				this.debugWithTimestamp(
					`[CalrecClient] Processing READ_MAIN_FADER_LEVEL, data length: ${data.length}`,
				);
				if (data.length >= 4) {
					const mainId = data.readUInt16BE(0);
					const level = data.readUInt16BE(2);
					this.debugWithTimestamp(
						`[CalrecClient] Emitting mainLevelChange: mainId=${mainId}, level=${level}`,
					);
					this.emit("mainLevelChange", mainId, level);
				} else {
					this.debugWithTimestamp(
						`[CalrecClient] READ_MAIN_FADER_LEVEL data too short: ${data.length} bytes`,
					);
				}
				break;
			case COMMANDS.READ_FADER_ASSIGNMENT:
				// Handle unsolicited fader assignment changes
				this.debugWithTimestamp(
					`[CalrecClient] Processing READ_FADER_ASSIGNMENT, data length: ${data.length}`,
				);
				if (data.length >= 6) {
					const assignment = this.parseResponseData(
						baseCommand,
						data,
					) as FaderAssignment;
					this.debugWithTimestamp(
						`[CalrecClient] Emitting faderAssignmentChange:`,
						assignment,
					);
					this.emit("faderAssignmentChange", assignment);
				} else {
					this.debugWithTimestamp(
						`[CalrecClient] READ_FADER_ASSIGNMENT data too short: ${data.length} bytes`,
					);
				}
				break;
			case COMMANDS.READ_AVAILABLE_AUX:
			case COMMANDS.READ_AVAILABLE_MAINS:
				this.emitAvailableChange(baseCommand, data);
				break;
			case COMMANDS.READ_UNKNOWN_03:
			case COMMANDS.READ_UNKNOWN_04:
			case COMMANDS.READ_UNKNOWN_06:
			case COMMANDS.READ_UNKNOWN_09:
			case COMMANDS.READ_UNKNOWN_0A:
			case COMMANDS.READ_UNKNOWN_0E:
			case COMMANDS.READ_UNKNOWN_0F:
				// These are known but undocumented commands - just emit without logging
				this.emit("unsolicitedMessage", { command, data });
				break;
			default: {
				const _commandName =
					Object.entries(COMMANDS).find(([_k, v]) => v === baseCommand)?.[0] ||
					`0x${baseCommand.toString(16)}`;
				this.debugWithTimestamp(
					`Unknown unsolicited message: Command 0x${command.toString(16)}, Data: ${data.toString("hex")}`,
				);
				this.emit("unsolicitedMessage", { command, data });
				break;
			}
		}
	}

	/**
	 * The console volunteers its aux/main availability during startup rather than
	 * only answering a read, so those pushes are turned into the same events a
	 * caller would get from getAvailableAux()/getAvailableMains().
	 */
	private emitAvailableChange(baseCommand: number, data: Buffer): void {
		const available = this.parseResponseData(baseCommand, data) as boolean[];
		if (baseCommand === COMMANDS.READ_AVAILABLE_AUX) {
			this.debugWithTimestamp(
				`[CalrecClient] Emitting availableAuxesChange: ${available.filter(Boolean).length} available`,
			);
			this.emit("availableAuxesChange", available);
		} else {
			this.debugWithTimestamp(
				`[CalrecClient] Emitting availableMainsChange: ${available.filter(Boolean).length} available`,
			);
			this.emit("availableMainsChange", available);
		}
	}

	private parseRoutingData(data: Buffer): boolean[] {
		const maxFaders = this.getEffectiveMaxFaderCount();
		const routes = new Array(maxFaders).fill(false);
		for (
			let byteIndex = 0;
			byteIndex < Math.min(data.length, Math.ceil(maxFaders / 8));
			byteIndex++
		) {
			const byte = data[byteIndex];
			for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
				const faderIndex = byteIndex * 8 + bitIndex;
				if (faderIndex < maxFaders) {
					routes[faderIndex] = (byte & (1 << bitIndex)) !== 0;
				}
			}
		}
		return routes;
	}

	private parseAvailableData(data: Buffer): boolean[] {
		const available = new Array(32).fill(false);
		for (let i = 0; i < Math.min(data.length, 32); i++) {
			available[i] = (data[i] & 0x01) !== 0;
		}
		return available;
	}

	private parseFaderAssignmentData(data: Buffer): FaderAssignment {
		if (data.length < 6) {
			return {
				faderId: 0,
				type: 0,
				width: 0,
				calrecId: 0,
			};
		}

		return {
			faderId: data.readUInt16BE(0),
			type: data[2],
			width: data[3],
			calrecId: data.readUInt16BE(4),
		};
	}

	private enqueueCommandWithResponse<T>(
		commandFn: () => Promise<T>,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				this.commandInFlight = true;
				commandFn()
					.then((result) => {
						this.commandInFlight = false;
						resolve(result);
						this.dequeueNextCommand();
					})
					.catch((err) => {
						this.commandInFlight = false;
						reject(err);
						this.dequeueNextCommand();
					});
			};
			this.commandResponseQueue.push(run);
			if (!this.commandInFlight) {
				this.dequeueNextCommand();
			}
		});
	}

	/**
	 * The protocol has no request IDs, so several in-flight reads can map to the
	 * same response key. Every one of them is kept so that no caller is left with
	 * a promise that never settles; replies are matched FIFO (one reply, one waiter).
	 */
	private addPendingRequest(requestKey: string, request: PendingRequest): void {
		const waiters = this.requestMap.get(requestKey);
		if (waiters) {
			waiters.push(request);
		} else {
			this.requestMap.set(requestKey, [request]);
		}
	}

	/**
	 * Removes a single waiter. Returns false if it was already settled, which lets
	 * a timeout know it lost the race against a response.
	 */
	private removePendingRequest(
		requestKey: string,
		request: PendingRequest,
	): boolean {
		const waiters = this.requestMap.get(requestKey);
		if (!waiters) return false;

		const index = waiters.indexOf(request);
		if (index === -1) return false;

		waiters.splice(index, 1);
		clearTimeout(request.timeout);
		if (waiters.length === 0) {
			this.requestMap.delete(requestKey);
		}
		return true;
	}

	/** Removes and returns the oldest waiter for a key, cancelling its timeout. */
	private takeOldestPendingRequest(
		requestKey: string,
	): PendingRequest | undefined {
		const waiters = this.requestMap.get(requestKey);
		if (!waiters || waiters.length === 0) return undefined;

		const request = waiters.shift();
		if (!request) return undefined;

		clearTimeout(request.timeout);
		if (waiters.length === 0) {
			this.requestMap.delete(requestKey);
		}
		return request;
	}

	/** Removes and returns every waiter for a key, cancelling their timeouts. */
	private takePendingRequests(requestKey: string): PendingRequest[] {
		const waiters = this.requestMap.get(requestKey);
		if (!waiters) return [];

		this.requestMap.delete(requestKey);
		for (const waiter of waiters) {
			clearTimeout(waiter.timeout);
		}
		return waiters;
	}

	/**
	 * A NAK carries no request id, so it can only be attributed to the oldest
	 * outstanding read. Sibling waiters on the same key keep waiting for their
	 * own replies (or timeouts).
	 */
	private rejectOldestPendingRequest(errorMessage: string): void {
		const oldestKey = this.requestMap.keys().next();
		if (oldestKey.done) {
			this.debugWithTimestamp(
				`[CalrecClient] NAK without pending request: ${errorMessage}`,
			);
			return;
		}

		const request = this.takeOldestPendingRequest(oldestKey.value);
		if (request) {
			request.reject(new Error(`NAK: ${errorMessage}`));
		}
	}

	/** Rejects every outstanding read, e.g. when the connection goes away. */
	private rejectAllPendingRequests(reason: string): void {
		for (const requestKey of [...this.requestMap.keys()]) {
			for (const request of this.takePendingRequests(requestKey)) {
				request.reject(new Error(reason));
			}
		}
	}

	private dequeueNextCommand() {
		if (!this.commandInFlight && this.commandResponseQueue.length > 0) {
			const next = this.commandResponseQueue.shift();
			if (next) next();
		}
	}

	private sendCommand<T>(
		command: number,
		data: Buffer = Buffer.alloc(0),
		isFaderLevel = false,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.state.connectionState !== ConnectionState.CONNECTED) {
				this.debugWithTimestamp(
					`[CalrecClient] Cannot send command - not connected. State: ${this.state.connectionState}`,
				);
				return reject(new Error("Not connected to the console."));
			}
			if (!this.socket) {
				this.debugWithTimestamp(
					`[CalrecClient] Cannot send command - no socket available`,
				);
				return reject(new Error("No socket available."));
			}

			const queue = isFaderLevel ? this.faderLevelQueue : this.commandQueue;
			queue.push({
				command,
				data,
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			// If it is a read command, set up the promise resolver and timeout
			if ((command & 0x8000) === 0) {
				const requestKey = buildRequestKey(command, data);

				const pendingRequest: PendingRequest = {
					resolve: resolve as (value: unknown) => void,
					reject,
				};
				pendingRequest.timeout = setTimeout(() => {
					if (this.removePendingRequest(requestKey, pendingRequest)) {
						this.debugWithTimestamp(
							`[CalrecClient] Command timeout for ${requestKey} (${command.toString(16)})`,
						);
						reject(
							new Error(
								`Request for command ${command.toString(16)} timed out after ${this.settings.commandResponseTimeoutMs}ms.`,
							),
						);
					}
				}, this.settings.commandResponseTimeoutMs);
				this.addPendingRequest(requestKey, pendingRequest);
			} else {
				// For write commands, resolve immediately
				resolve(undefined as T);
			}

			if (!this.isProcessing) {
				this.processCommandQueue();
			}
		});
	}

	private sendCommandWithQueue<T>(
		command: number,
		data: Buffer = Buffer.alloc(0),
		isFaderLevel = false,
	): Promise<T> {
		if ((command & 0x8000) === 0) {
			return this.enqueueCommandWithResponse(() =>
				this.sendCommand<T>(command, data, isFaderLevel),
			);
		} else {
			return this.sendCommand<T>(command, data, isFaderLevel);
		}
	}

	private async processCommandQueue(): Promise<void> {
		if (
			this.isProcessing ||
			this.state.connectionState !== ConnectionState.CONNECTED
		) {
			if (this.isProcessing) {
				this.debugWithTimestamp(
					`[CalrecClient] Skipping command queue processing - already processing`,
				);
			} else {
				this.debugWithTimestamp(
					`[CalrecClient] Skipping command queue processing - not connected. State: ${this.state.connectionState}`,
				);
			}
			return;
		}
		this.isProcessing = true;

		if (!this.socket) {
			this.debugWithTimestamp(
				`[CalrecClient] Cannot process command queue - no socket available`,
			);
			this.isProcessing = false;
			return;
		}

		const now = Date.now();
		const timeSinceLastCommand = now - this.lastCommandSent;
		if (timeSinceLastCommand < this.settings.globalCommandRateMs) {
			this.isProcessing = false;
			setTimeout(
				() => this.processCommandQueue(),
				this.settings.globalCommandRateMs - timeSinceLastCommand,
			);
			return;
		}

		if (
			this.faderLevelQueue.length > 0 &&
			Date.now() - this.lastFaderLevelSent > this.settings.faderLevelRateMs
		) {
			const nextFaderCommand = this.faderLevelQueue.shift();
			if (nextFaderCommand) {
				const { command, data } = nextFaderCommand;
				const faderId = data.length >= 2 ? data.readUInt16BE(0) : undefined;
				const commandName =
					Object.entries(COMMANDS).find(([_k, v]) => v === command)?.[0] ||
					command.toString(16);
				const packet = buildPacket(command, data);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? `, faderId: ${faderId}` : ""}`,
				);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX HEX: ${packet.toString("hex").toUpperCase()}`,
				);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX BYTES: [${Array.from(packet)
						.map((b) => `0x${b.toString(16).padStart(2, "0")}`)
						.join(", ")}]`,
				);
				this.socket.write(packet);
				this.lastFaderLevelSent = Date.now();
				this.lastCommandSent = Date.now();
			}
		} else if (this.commandQueue.length > 0) {
			const nextCommand = this.commandQueue.shift();
			if (nextCommand) {
				const { command, data } = nextCommand;
				const faderId = data.length >= 2 ? data.readUInt16BE(0) : undefined;
				const commandName =
					Object.entries(COMMANDS).find(([_k, v]) => v === command)?.[0] ||
					command.toString(16);
				const packet = buildPacket(command, data);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? `, faderId: ${faderId}` : ""}`,
				);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX HEX: ${packet.toString("hex").toUpperCase()}`,
				);
				this.debugWithTimestamp(
					`[CalrecClient] >>> TX BYTES: [${Array.from(packet)
						.map((b) => `0x${b.toString(16).padStart(2, "0")}`)
						.join(", ")}]`,
				);
				this.socket.write(packet);
				this.lastCommandSent = Date.now();
			}
		}

		this.isProcessing = false;

		if (this.commandQueue.length > 0 || this.faderLevelQueue.length > 0) {
			setTimeout(
				() => this.processCommandQueue(),
				this.settings.globalCommandRateMs,
			);
		}
	}

	// --- PUBLIC API METHODS ---

	/**
	 * Get the current state of the client.
	 * @returns A copy of the current client state.
	 */
	public getState(): ClientState {
		return { ...this.state };
	}

	/**
	 * Get the current connection state.
	 * @returns The current connection state.
	 */
	public getConnectionState(): ConnectionState {
		return this.state.connectionState;
	}

	/**
	 * Throws if the client is not connected.
	 * Used internally by all public API methods.
	 */
	private ensureConnected(): void {
		if (this.state.connectionState !== ConnectionState.CONNECTED) {
			throw new Error(
				`Client is not connected. Current state: ${this.state.connectionState}`,
			);
		}
	}

	/**
	 * Get information about the connected console.
	 * @returns Promise resolving to ConsoleInfo.
	 */
	public async getConsoleInfo(): Promise<ConsoleInfo> {
		this.ensureConnected();
		return this.sendCommand(COMMANDS.READ_CONSOLE_INFO);
	}

	/**
	 * Get the name of the connected console.
	 * @returns Promise resolving to the console name.
	 */
	public async getConsoleName(): Promise<string> {
		this.ensureConnected();
		return this.sendCommand(COMMANDS.READ_CONSOLE_NAME);
	}

	/**
	 * Set the fader level for a given fader.
	 * @param faderId The fader ID.
	 * @param level The protocol level (0-1023).
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setFaderLevel(faderId: number, level: number): Promise<void> {
		this.ensureConnected();

		// Validate fader ID
		if (faderId < 0 || faderId >= this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 0 and ${this.getEffectiveMaxFaderCount() - 1}.`,
			);
		}

		// Ignore out-of-range levels so relative up/down commands become no-ops
		// when a caller's source value is already invalid.
		if (level < 0 || level > 1023) {
			return;
		}

		const data = Buffer.alloc(4);
		data.writeUInt16BE(faderId, 0);
		data.writeUInt16BE(level, 2);
		await this.sendCommand(COMMANDS.WRITE_FADER_LEVEL, data, true);
	}

	/**
	 * Get the fader level for a given fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the protocol level (0-1023).
	 */
	public async getFaderLevel(faderId: number): Promise<number> {
		this.ensureConnected();

		// Validate fader ID
		if (faderId < 0 || faderId >= this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 0 and ${this.getEffectiveMaxFaderCount() - 1}.`,
			);
		}

		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		return this.sendCommand(COMMANDS.READ_FADER_LEVEL, data);
	}

	/**
	 * Set the cut state for a fader.
	 * @param faderId The fader ID.
	 * @param isCut True to cut, false to uncut.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setFaderCut(faderId: number, isCut: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(faderId, 0);
		data[2] = isCut ? 0 : 1;
		await this.sendCommand(COMMANDS.WRITE_FADER_CUT, data);
	}

	/**
	 * Get the label for a fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the fader label.
	 */
	public async getFaderLabel(faderId: number): Promise<string> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		const label = await this.sendCommandWithQueue(
			COMMANDS.READ_FADER_LABEL,
			data,
		);
		if (typeof label === "object" && label !== null && Buffer.isBuffer(label)) {
			return label.slice(2).toString("ascii");
		}
		return typeof label === "string" ? label : String(label);
	}

	/**
	 * Get the label for a main fader.
	 * @param mainId The main fader ID.
	 * @returns Promise resolving to the main fader label.
	 */
	public async getMainFaderLabel(mainId: number): Promise<string> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(mainId, 0);
		const label = await this.sendCommandWithQueue(
			COMMANDS.READ_MAIN_FADER_LABEL,
			data,
		);
		if (typeof label === "object" && label !== null && Buffer.isBuffer(label)) {
			return label.slice(2).toString("ascii");
		}
		return typeof label === "string" ? label : String(label);
	}

	/**
	 * Get the cut state for a fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the cut state (true = cut, false = uncut).
	 */
	public async getFaderCut(faderId: number): Promise<boolean> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		// parseResponseData has already applied the 0 = cut convention.
		return this.sendCommand<boolean>(COMMANDS.READ_FADER_CUT, data);
	}

	/**
	 * Get the PFL state for a fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the PFL state (true = PFL on, false = PFL off).
	 */
	public async getFaderPfl(faderId: number): Promise<boolean> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		// parseResponseData has already applied the 1 = PFL on convention.
		return this.sendCommand<boolean>(COMMANDS.READ_FADER_PFL, data);
	}

	/**
	 * Get the PFL state for a main fader.
	 * @param mainId The main fader ID.
	 * @returns Promise resolving to the PFL state (true = PFL on, false = PFL off).
	 */
	public async getMainPfl(mainId: number): Promise<boolean> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(mainId, 0);
		// parseResponseData has already applied the 1 = PFL on convention.
		return this.sendCommand<boolean>(COMMANDS.READ_MAIN_PFL, data);
	}

	/**
	 * Get available auxiliary outputs (V20+).
	 * @returns Promise resolving to array of booleans indicating available auxes.
	 */
	public async getAvailableAux(): Promise<boolean[]> {
		this.ensureConnected();

		const result = await this.sendCommand(COMMANDS.READ_AVAILABLE_AUX);
		if (Array.isArray(result)) {
			return result;
		}
		// If result is not an array, try to parse it from buffer
		if (Buffer.isBuffer(result)) {
			const available = new Array(32).fill(false); // Assume max 32 auxes
			for (let i = 0; i < Math.min(result.length, 32); i++) {
				available[i] = (result[i] & 0x01) !== 0;
			}
			return available;
		}
		return new Array(32).fill(false); // Default fallback
	}

	/**
	 * Get available main outputs (V21+).
	 * @returns Promise resolving to array of booleans indicating available mains.
	 */
	public async getAvailableMains(): Promise<boolean[]> {
		this.ensureConnected();

		const result = await this.sendCommand(COMMANDS.READ_AVAILABLE_MAINS);
		if (Array.isArray(result)) {
			return result;
		}
		// If result is not an array, try to parse it from buffer
		if (Buffer.isBuffer(result)) {
			const available = new Array(16).fill(false); // Assume max 16 mains
			for (let i = 0; i < Math.min(result.length, 16); i++) {
				available[i] = (result[i] & 0x01) !== 0;
			}
			return available;
		}
		return new Array(16).fill(false); // Default fallback
	}

	/**
	 * Get aux routing for an aux bus (V20+).
	 * @param auxId The aux bus ID.
	 * @returns Promise resolving to array of booleans for each fader route.
	 */
	public async getAuxSendRouting(auxId: number): Promise<boolean[]> {
		this.ensureConnected();

		const data = Buffer.alloc(2);
		data.writeUInt16BE(auxId, 0);
		const result = await this.sendCommand(COMMANDS.READ_AUX_SEND_ROUTING, data);

		if (Array.isArray(result)) {
			return result;
		}
		// If result is not an array, try to parse it from buffer
		if (Buffer.isBuffer(result)) {
			const maxFaders = this.getEffectiveMaxFaderCount();
			const routes = new Array(maxFaders).fill(false);
			for (
				let byteIndex = 0;
				byteIndex < Math.min(result.length, Math.ceil(maxFaders / 8));
				byteIndex++
			) {
				const byte = result[byteIndex];
				for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
					const faderIndex = byteIndex * 8 + bitIndex;
					if (faderIndex < maxFaders) {
						routes[faderIndex] = (byte & (1 << bitIndex)) !== 0;
					}
				}
			}
			return routes;
		}
		return new Array(this.getEffectiveMaxFaderCount()).fill(false); // Default fallback
	}

	/**
	 * Set aux routing for an aux bus.
	 * @param auxId The aux bus ID.
	 * @param routes Array of booleans for each fader.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setAuxRouting(auxId: number, routes: boolean[]): Promise<void> {
		this.ensureConnected();
		const maxFaders = this.getEffectiveMaxFaderCount();
		if (routes.length > maxFaders)
			throw new Error(`Maximum of ${maxFaders} fader routes allowed.`);
		const data = Buffer.alloc(26);
		data[0] = auxId;
		data[1] = 0;
		for (let byteIndex = 0; byteIndex < 24; byteIndex++) {
			let byte = 0;
			for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
				const faderIndex = byteIndex * 8 + bitIndex;
				if (faderIndex < routes.length && routes[faderIndex]) {
					byte |= 1 << bitIndex;
				}
			}
			data[2 + byteIndex] = byte;
		}
		await this.sendCommand(COMMANDS.WRITE_AUX_SEND_ROUTING, data);
	}

	/**
	 * Set the PFL (pre-fade listen) state for a fader.
	 * @param faderId The fader ID.
	 * @param isPfl True to enable PFL, false to disable.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setFaderPfl(faderId: number, isPfl: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(faderId, 0);
		data[2] = isPfl ? 1 : 0;
		await this.sendCommand(COMMANDS.WRITE_FADER_PFL, data);
	}

	/**
	 * Set the PFL (pre-fade listen) state for a main fader.
	 * @param mainId The main fader ID.
	 * @param isPfl True to enable PFL, false to disable.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setMainFaderPfl(mainId: number, isPfl: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(mainId, 0);
		data[2] = isPfl ? 1 : 0;
		await this.sendCommand(COMMANDS.WRITE_MAIN_PFL, data);
	}

	/**
	 * Set the output level for an aux bus.
	 * @param auxId The aux bus ID.
	 * @param level The protocol level (0-1023).
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setAuxOutputLevel(auxId: number, level: number): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(4);
		data.writeUInt16BE(auxId, 0);
		data.writeUInt16BE(Math.min(1023, Math.max(0, level)), 2);
		await this.sendCommand(COMMANDS.WRITE_AUX_OUTPUT_LEVEL, data);
	}

	/**
	 * Get the output level for an aux bus.
	 * @param auxId The aux bus ID.
	 * @returns Promise resolving to the protocol level (0-1023).
	 */
	public async getAuxOutputLevel(auxId: number): Promise<number> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(auxId, 0);
		return this.sendCommand(COMMANDS.READ_AUX_OUTPUT_LEVEL, data);
	}

	/**
	 * Set routing to a main bus.
	 * @param mainId The main bus ID.
	 * @param routes Array of booleans for each fader.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setRouteToMain(
		mainId: number,
		routes: boolean[],
	): Promise<void> {
		this.ensureConnected();
		const maxFaders = this.getEffectiveMaxFaderCount();
		if (routes.length > maxFaders)
			throw new Error(`Maximum of ${maxFaders} main routes allowed.`);
		const data = Buffer.alloc(26);
		data[0] = mainId;
		data[1] = 0;
		for (let byteIndex = 0; byteIndex < 24; byteIndex++) {
			let byte = 0;
			for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
				const routeIndex = byteIndex * 8 + bitIndex;
				if (routeIndex < routes.length && routes[routeIndex]) {
					byte |= 1 << bitIndex;
				}
			}
			data[2 + byteIndex] = byte;
		}
		await this.sendCommand(COMMANDS.WRITE_ROUTE_TO_MAIN, data);
	}

	/**
	 * Set the stereo image for a fader.
	 * @param faderId The fader ID.
	 * @param image The stereo image configuration.
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setStereoImage(
		faderId: number,
		image: { leftToBoth: boolean; rightToBoth: boolean },
	): Promise<void> {
		this.ensureConnected();

		// Validate fader ID
		if (faderId < 0 || faderId >= this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 0 and ${this.getEffectiveMaxFaderCount() - 1}.`,
			);
		}

		const data = Buffer.alloc(32);
		data.writeUInt16BE(faderId, 0);

		// Set the stereo image bits
		if (image.leftToBoth) data[2] = 1;
		if (image.rightToBoth) data[3] = 1;

		await this.sendCommand(COMMANDS.WRITE_STEREO_IMAGE, data);
	}

	/**
	 * Get the assignment for a fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the fader assignment.
	 */
	public async getFaderAssignment(faderId: number): Promise<FaderAssignment> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		const result = await this.sendCommand<FaderAssignment>(
			COMMANDS.READ_FADER_ASSIGNMENT,
			data,
		);
		return result as FaderAssignment;
	}

	/**
	 * Get the stereo image for a fader.
	 * @param faderId The fader ID.
	 * @returns Promise resolving to the stereo image.
	 */
	public async getStereoImage(faderId: number): Promise<StereoImage> {
		this.ensureConnected();

		// Validate fader ID
		if (faderId < 0 || faderId >= this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 0 and ${this.getEffectiveMaxFaderCount() - 1}.`,
			);
		}

		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		const response = await this.sendCommand<StereoImage>(
			COMMANDS.READ_STEREO_IMAGE,
			data,
		);
		return response;
	}

	/**
	 * Sets a fader level using decibels (dB) instead of raw protocol levels.
	 * Uses channel fader conversion curve.
	 * @param faderId The fader ID.
	 * @param db The decibel value (typically -100 to +10 dB for channel faders).
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setFaderLevelDb(faderId: number, db: number): Promise<void> {
		this.ensureConnected();
		const level = dbToChannelLevel(db);
		await this.setFaderLevel(faderId, level);
	}

	/**
	 * Gets a fader level in decibels (dB) instead of raw protocol levels.
	 * Uses channel fader conversion curve.
	 * @param faderId The fader ID.
	 * @returns Promise that resolves to the decibel value.
	 */
	public async getFaderLevelDb(faderId: number): Promise<number> {
		this.ensureConnected();
		const level = await this.getFaderLevel(faderId);
		return channelLevelToDb(level);
	}

	/**
	 * Sets a main fader level using decibels (dB) instead of raw protocol levels.
	 * Uses main fader conversion curve.
	 * @param faderId The main fader ID.
	 * @param db The decibel value (typically -100 to 0 dB for main faders).
	 * @returns Promise that resolves when the command is sent.
	 */
	public async setMainFaderLevelDb(faderId: number, db: number): Promise<void> {
		this.ensureConnected();
		const level = dbToMainLevel(db);
		await this.setFaderLevel(faderId, level);
	}

	/**
	 * Gets a main fader level in decibels (dB) instead of raw protocol levels.
	 * Uses main fader conversion curve.
	 * @param faderId The main fader ID.
	 * @returns Promise that resolves to the decibel value.
	 */
	public async getMainFaderLevelDb(faderId: number): Promise<number> {
		this.ensureConnected();
		const level = await this.getFaderLevel(faderId);
		return mainLevelToDb(level);
	}

	/**
	 * Get the effective maximum fader count based on configuration.
	 * @returns The maximum number of faders to use for validation and array sizing.
	 */
	private getEffectiveMaxFaderCount(): number {
		return this.options.maxFaderCount;
	}

	/**
	 * Get the effective maximum fader count for external use.
	 * This is the same as the private method but accessible to consumers.
	 * @returns The maximum number of faders to use for validation and array sizing.
	 */
	public getMaxFaderCount(): number {
		return this.getEffectiveMaxFaderCount();
	}

	/**
	 * Get the effective maximum main count based on configuration.
	 * @returns The maximum number of mains to use for validation and array sizing.
	 */
	private getEffectiveMaxMainCount(): number {
		return this.options.maxMainCount || 3;
	}

	private debugWithTimestamp(...args: unknown[]) {
		if (this.debug) {
			const timestamp = new Date().toISOString();
			console.debug(`[${timestamp}]`, ...args);
		}
	}
}
