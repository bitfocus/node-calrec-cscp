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
}

const DEFAULT_SETTINGS: Required<CalrecClientSettings> = {
	globalCommandRateMs: 10,
	faderLevelRateMs: 100,
	commandResponseTimeoutMs: 500,
	initializationTimeoutMs: 200,
};

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
	private requestMap = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (reason?: Error) => void }
	>();
	private commandResponseQueue: Array<() => void> = [];
	private commandInFlight: boolean = false;
	private maxFaderCount?: number;
	private settings: Required<CalrecClientSettings>;
	private debug: boolean;

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

		this.socket = new net.Socket();

		await new Promise<void>((resolve, reject) => {
			this.socket?.once("error", (err) => {
				this.debugWithTimestamp(
					`[CalrecClient] Socket connection error: ${err.message}`,
				);
				reject(err);
			});
			this.socket?.connect(this.options.port, this.options.host, () => {
				this.socket?.off("error", reject);
				this.debugWithTimestamp(
					`[CalrecClient] Socket connected to ${this.options.host}:${this.options.port}`,
				);
				resolve();
			});
		});

		this.setState({ connectionState: ConnectionState.CONNECTED });
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
		this.socket?.destroy();
		this.socket = null;
		this.emit("disconnect");

		if (this.state.connectionState !== ConnectionState.DISCONNECTED) {
			this.setState({
				connectionState: ConnectionState.DISCONNECTED,
				consoleInfo: null,
				consoleName: null,
			});
		}

		if (this.options.autoReconnect) {
			this.setState({ connectionState: ConnectionState.RECONNECTING });
			this.reconnectTimeout = setTimeout(
				() => this.connect(),
				this.options.reconnectInterval,
			);
		}
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

		// Process ACK/NAK messages first
		if (this.dataBuffer.length > 0) {
			if (this.dataBuffer[0] === ACK) {
				this.debugWithTimestamp(`[CalrecClient] <<< RX: ACK (0x06)`);
				this.dataBuffer = this.dataBuffer.slice(1);
				return;
			}
			if (this.dataBuffer[0] === NAK) {
				if (this.dataBuffer.length > 1) {
					const errorCode = this.dataBuffer[1];
					const errorMessage = parseNakError(errorCode);
					this.debugWithTimestamp(
						`[CalrecClient] <<< RX: NAK (0x15) - ${errorMessage} (code: ${errorCode})`,
					);

					// Try to reject the matching pending request
					let matched = false;
					for (const [requestKey, { reject }] of this.requestMap.entries()) {
						reject(new Error(`NAK: ${errorMessage}`));
						this.requestMap.delete(requestKey);
						matched = true;
						break; // Only reject one per NAK
					}
					if (!matched) {
						this.debugWithTimestamp(
							`[CalrecClient] NAK without pending request: ${errorMessage}`,
						);
					}
					this.dataBuffer = this.dataBuffer.slice(2);
					return;
				}
				// Debug: NAK without error code
				this.debugWithTimestamp(
					`[CalrecClient] <<< RX: NAK (0x15) without error code. Buffer: ${this.dataBuffer.toString("hex").toUpperCase()}`,
				);
				this.dataBuffer = this.dataBuffer.slice(1);
				return;
			}
		}

		// Process complete packets
		while (this.dataBuffer.length > 0) {
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

		const readCmd = command & 0x7fff;
		let requestKey = `${readCmd}`;

		// Global commands (like getConsoleInfo) don't have an ID in their request,
		// so their key is just the command number.
		// ID-specific commands (like getFaderLevel) need the ID appended to the key.
		const nonIdSpecificCommands = [
			COMMANDS.READ_CONSOLE_INFO,
			COMMANDS.READ_CONSOLE_NAME,
			COMMANDS.READ_AVAILABLE_AUX,
			COMMANDS.READ_AVAILABLE_MAINS,
			COMMANDS.READ_STEREO_IMAGE,
		] as const;
		const isIdSpecificCommand = !nonIdSpecificCommands.includes(
			readCmd as (typeof nonIdSpecificCommands)[number],
		);

		if (isIdSpecificCommand && data.length >= 2) {
			const id = data.readUInt16BE(0);
			requestKey = `${readCmd}:${id}`;
		}

		const pendingRequest = this.requestMap.get(requestKey);
		if (pendingRequest) {
			this.requestMap.delete(requestKey);
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
			case COMMANDS.READ_FADER_LABEL:
				// Optionally parse and cache fader label if needed
				// this.debugWithTimestamp(`[CalrecClient] Received unsolicited fader label:`, data);
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
				let requestKey = `${command}`;
				if (data.length >= 2) {
					requestKey = `${command}:${data.readUInt16BE(0)}`;
				}
				this.requestMap.set(requestKey, {
					resolve: resolve as (value: unknown) => void,
					reject,
				});

				// Timeout handler for command response
				const handleCommandTimeout = () => {
					if (this.requestMap.has(requestKey)) {
						this.requestMap.delete(requestKey);
						this.debugWithTimestamp(
							`[CalrecClient] Command timeout for ${requestKey} (${command.toString(16)})`,
						);
						reject(
							new Error(
								`Request for command ${command.toString(16)} timed out after ${this.settings.commandResponseTimeoutMs}ms.`,
							),
						);
					}
				};
				setTimeout(
					handleCommandTimeout,
					this.settings.commandResponseTimeoutMs,
				);
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
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
			);
		}

		// Validate level
		if (level < 0 || level > 1023) {
			throw new Error(
				`Invalid fader level: ${level}. Must be between 0 and 1023.`,
			);
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
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
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
		const result = await this.sendCommand(COMMANDS.READ_FADER_CUT, data);
		return result === 0; // 0 = cut, 1 = uncut
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
		const result = await this.sendCommand(COMMANDS.READ_FADER_PFL, data);
		return result === 1; // 1 = PFL on, 0 = PFL off
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
		const result = await this.sendCommand(COMMANDS.READ_MAIN_PFL, data);
		return result === 1; // 1 = PFL on, 0 = PFL off
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
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
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
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
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
