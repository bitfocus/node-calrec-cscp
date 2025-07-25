// src/client.ts

import { EventEmitter } from "node:events";
import * as net from "node:net";
import {
	ACK,
	buildPacket,
	COMMANDS,
	NAK,
	parsePacket,
	isCommandSupported,
	SOH,
} from "./protocol";
import {
	type CalrecClientEvents,
	type CalrecClientOptions,
	ConnectionState,
	type ConsoleInfo,
	NakError,
	type ParsedMessage,
	type ClientState,
	type FaderAssignment,
	type StereoImage,
} from "./types";
import {
	dbToChannelLevel,
	dbToMainLevel,
	channelLevelToDb,
	mainLevelToDb,
} from "./converters";

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
	initializationTimeoutMs: 100,
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

	constructor(
		options: CalrecClientOptions,
		settings: CalrecClientSettings = {},
	) {
		super();
		const { maxFaderCount, ...rest } = options;
		this.options = {
			autoReconnect: true,
			reconnectInterval: 5000,
			...rest,
		};
		this.maxFaderCount = maxFaderCount;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
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
			console.debug(
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
				console.debug(`[CalrecClient] Socket connection error: ${err.message}`);
				reject(err);
			});
			this.socket?.connect(this.options.port, this.options.host, () => {
				this.socket?.off("error", reject);
				console.debug(
					`[CalrecClient] Socket connected to ${this.options.host}:${this.options.port}`,
				);
				resolve();
			});
		});

		this.setState({ connectionState: ConnectionState.CONNECTED });
		this.emit("connect");

		setTimeout(() => this.processCommandQueue(), 1000);

		try {
			// Wait for console info with retries
			console.debug(`[CalrecClient] Requesting console info with retries...`);
			
			const consoleInfo = await this.getConsoleInfoWithRetries();

			if (consoleInfo) {
				console.debug(`[CalrecClient] Received console info:`, consoleInfo);
				this.setState({ consoleInfo });
			} else {
				console.debug(
					`[CalrecClient] No console info received after retries, using defaults`,
				);
			}

			// Continue with initialization
			console.debug(`[CalrecClient] Console initialized`);
			this.emit("ready");
		} catch (error) {
			console.debug(`[CalrecClient] Failed to initialize console: ${error}`);
			this.setState({ connectionState: ConnectionState.ERROR });
			this.emit("error", error as Error);
			throw error;
		}

		this.socket.on("data", this.handleData.bind(this));
		this.socket.on("close", this.handleDisconnect.bind(this));
		this.socket.on("error", (err) => {
			console.debug(
				`[CalrecClient] Socket error after connection: ${err.message}`,
			);
			this.setState({ connectionState: ConnectionState.ERROR });
			this.emit("error", err);
		});
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
		this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);

		// Debug: Log incoming data for troubleshooting
		if (this.dataBuffer.length > 0 && this.dataBuffer.length < 100) {
			console.debug(
				`[CalrecClient] Buffer: ${this.dataBuffer.toString("hex")}`,
			);
		}

		// Process ACK/NAK messages first
		if (this.dataBuffer.length > 0) {
			if (this.dataBuffer[0] === ACK) {
				console.debug(`[CalrecClient] Received ACK`);
				this.dataBuffer = this.dataBuffer.slice(1);
				return;
			}
			if (this.dataBuffer[0] === NAK) {
				if (this.dataBuffer.length > 1) {
					const errorCode = this.dataBuffer[1];
					const errorMessage = parseNakError(errorCode);
					console.debug(
						`[CalrecClient] Received NAK: ${errorMessage} (code: ${errorCode})`,
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
						console.debug(
							`[CalrecClient] NAK without pending request: ${errorMessage}`,
						);
					}
					this.dataBuffer = this.dataBuffer.slice(2);
					return;
				}
				// Debug: NAK without error code
				console.debug(
					`[CalrecClient] Received NAK without error code. Buffer: ${this.dataBuffer.toString("hex")}`,
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
					console.debug(
						`[CalrecClient] No SOH found in buffer after 100+ bytes. Buffer: ${this.dataBuffer.toString("hex")}`,
					);
					// Try to find any potential packet start
					const potentialStart = this.dataBuffer.indexOf(0xf1);
					if (potentialStart !== -1) {
						console.debug(
							`[CalrecClient] Found potential start at ${potentialStart}: 0xf1`,
						);
					}
				}
				return;
			}

			// Remove any data before SOH
			if (sohIndex > 0) {
				console.debug(
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

			console.debug(
				`[CalrecClient] Processing packet: ${packetWithSoh.toString("hex")}`,
			);

			this.dataBuffer = this.dataBuffer.slice(messageLength);

			const parsed = parsePacket(messageBufferForParser);

			if (parsed instanceof Error) {
				console.debug(
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
		const isIdSpecificCommand = ![
			COMMANDS.READ_CONSOLE_INFO,
			COMMANDS.READ_CONSOLE_NAME,
			COMMANDS.READ_AVAILABLE_AUX,
			COMMANDS.READ_AVAILABLE_MAINS,
			COMMANDS.READ_STEREO_IMAGE,
		].includes(readCmd as any);

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
					const name = data.toString("ascii").trim();
					console.debug(`[CalrecClient] Parsed console name: "${name}"`);
					return name || "Unknown";
				} catch (error) {
					console.debug(
						`[CalrecClient] Failed to parse console name: ${error}, data: ${data.toString("hex")}`,
					);
					return "Unknown";
				}
			case COMMANDS.READ_FADER_LABEL:
			case COMMANDS.READ_MAIN_FADER_LABEL:
				return data.slice(2).toString("ascii");
			case COMMANDS.READ_CONSOLE_INFO:
				// Data for console info doesn't start with the ID, so we parse from the beginning
				try {
					console.debug(
						`[CalrecClient] Parsing console info data: ${data.toString("hex")}, length: ${data.length}`,
					);

					if (data.length < 20) {
						console.debug(
							`[CalrecClient] Console info data too short: ${data.length} bytes, expected at least 20`,
						);
						return {
							protocolVersion: 1, // Default to version 1
							maxFaders: this.getEffectiveMaxFaderCount(), // Use effective max fader count
							maxMains: this.getEffectiveMaxMainCount(), // Use effective max main count
							deskLabel: "Unknown",
						} as ConsoleInfo;
					}

					const protocolVersion = data.readUInt16BE(0);
					const maxFaders = data.readUInt16BE(2);
					const maxMains = data.readUInt16BE(4);
					const deskLabel = data.slice(12, 20).toString("ascii").trim();

					console.debug(
						`[CalrecClient] Parsed console info: version=${protocolVersion}, faders=${maxFaders}, mains=${maxMains}, label="${deskLabel}"`,
					);

					return {
						protocolVersion,
						maxFaders,
						maxMains,
						deskLabel: deskLabel || "Unknown",
					} as ConsoleInfo;
				} catch (error) {
					console.debug(
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
						console.debug(
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

					console.debug(
						`[CalrecClient] Parsed fader assignment: faderId=${faderId}, type=${type}, width=${width}, calrecId=${calrecId}`,
					);

					return {
						faderId,
						type,
						width,
						calrecId,
					} as FaderAssignment;
				} catch (error) {
					console.debug(
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
					console.debug(
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
					console.debug(
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
					console.debug(
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
					console.debug(
						`[CalrecClient] Failed to parse aux send routing: ${error}, data: ${data.toString("hex")}`,
					);
					return new Array(this.getEffectiveMaxFaderCount()).fill(false);
				}
			case COMMANDS.READ_ROUTE_TO_MAIN:
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
					console.debug(
						`[CalrecClient] Failed to parse route to main: ${error}, data: ${data.toString("hex")}`,
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
				console.debug(
					`[CalrecClient] Unhandled response data for command: ${command.toString(16)}`,
				);
				return data;
		}
	}

	private emitUnsolicitedEvent(command: number, data: Buffer): void {
		const id = data.length >= 2 ? data.readUInt16BE(0) : -1;
		switch (command) {
			case COMMANDS.WRITE_FADER_LEVEL:
				this.emit("faderLevelChange", id, data.readUInt16BE(2));
				break;
			case COMMANDS.WRITE_FADER_CUT:
				this.emit("faderCutChange", id, data[2] === 0);
				break;
			case COMMANDS.WRITE_FADER_PFL:
				this.emit("faderPflChange", id, data[2] === 1);
				break;
			case COMMANDS.WRITE_MAIN_FADER_LEVEL:
				this.emit("mainLevelChange", id, data.readUInt16BE(2));
				break;
			case COMMANDS.WRITE_MAIN_PFL:
				this.emit("mainPflChange", id, data[2] === 1);
				break;
			case COMMANDS.WRITE_AUX_OUTPUT_LEVEL:
				this.emit("auxOutputLevelChange", id, data.readUInt16BE(2));
				break;
			case COMMANDS.WRITE_AUX_SEND_ROUTING: {
				// For routing commands, the ID is in the first byte, not first two bytes
				const auxId = data[0];
				this.emit(
					"auxRoutingChange",
					auxId,
					this.parseRoutingData(data.slice(2)),
				);
				break;
			}
			case COMMANDS.WRITE_ROUTE_TO_MAIN: {
				// For routing commands, the ID is in the first byte, not first two bytes
				const mainId = data[0];
				this.emit(
					"mainRoutingChange",
					mainId,
					this.parseRoutingData(data.slice(2)),
				);
				break;
			}
			case COMMANDS.WRITE_STEREO_IMAGE:
				this.emit("stereoImageChange", id, {
					leftToBoth: !!data[2],
					rightToBoth: !!data[3],
				});
				break;
			case COMMANDS.READ_FADER_LABEL: {
				const labelBuf = data.slice(2);
				const labelStr = Buffer.isBuffer(labelBuf)
					? labelBuf.toString("utf8")
					: String(labelBuf);
				this.emit("faderLabelChange", id, labelStr);
				break;
			}
			case COMMANDS.READ_MAIN_FADER_LABEL: {
				const labelBuf = data.slice(2);
				const labelStr = Buffer.isBuffer(labelBuf)
					? labelBuf.toString("utf8")
					: String(labelBuf);
				this.emit("mainLabelChange", id, labelStr);
				break;
			}
			case COMMANDS.WRITE_FADER_ASSIGNMENT: {
				const assignment = this.parseFaderAssignmentData(data);
				this.emit("faderAssignmentChange", assignment);
				break;
			}
			case COMMANDS.WRITE_AVAILABLE_AUX:
				this.emit("availableAuxesChange", this.parseAvailableData(data));
				break;
			case COMMANDS.WRITE_AVAILABLE_MAINS:
				this.emit("availableMainsChange", this.parseAvailableData(data));
				break;
			case COMMANDS.READ_CONSOLE_NAME:
			case COMMANDS.READ_CONSOLE_INFO:
				// These are expected unsolicited messages but don't need specific event emission
				break;
			default: {
				// Only log truly unknown commands, not the ones we expect as unsolicited
				const commandName =
					Object.entries(COMMANDS).find(([k, v]) => v === command)?.[0] ||
					`0x${command.toString(16)}`;

				// Don't log debug messages for commands we expect as unsolicited
				// Just emit the unsolicited message event
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

	private parseFaderAssignmentData(data: Buffer): any {
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
				console.debug(
					`[CalrecClient] Cannot send command - not connected. State: ${this.state.connectionState}`,
				);
				return reject(new Error("Not connected to the console."));
			}
			if (!this.socket) {
				console.debug(
					`[CalrecClient] Cannot send command - no socket available`,
				);
				return reject(new Error("No socket available."));
			}

			// Check protocol version compatibility if we have console info
			if (this.state.consoleInfo) {
				const readCmd = command & 0x7fff;
				if (
					!isCommandSupported(readCmd, this.state.consoleInfo.protocolVersion)
				) {
					const commandName =
						Object.entries(COMMANDS).find(([k, v]) => v === readCmd)?.[0] ||
						`0x${readCmd.toString(16)}`;
					return reject(
						new Error(
							`Command ${commandName} (0x${readCmd.toString(16)}) is not supported by protocol version ${this.state.consoleInfo.protocolVersion}`,
						),
					);
				}
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
						console.debug(
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
				console.debug(
					`[CalrecClient] Skipping command queue processing - already processing`,
				);
			} else {
				console.debug(
					`[CalrecClient] Skipping command queue processing - not connected. State: ${this.state.connectionState}`,
				);
			}
			return;
		}
		this.isProcessing = true;

		if (!this.socket) {
			console.debug(
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
					Object.entries(COMMANDS).find(([k, v]) => v === command)?.[0] ||
					command.toString(16);
				console.debug(
					`[CalrecClient] Sending faderLevelQueue command: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? `, faderId: ${faderId}` : ""}`,
				);
				this.socket.write(buildPacket(command, data));
				this.lastFaderLevelSent = Date.now();
				this.lastCommandSent = Date.now();
			}
		} else if (this.commandQueue.length > 0) {
			const nextCommand = this.commandQueue.shift();
			if (nextCommand) {
				const { command, data } = nextCommand;
				const faderId = data.length >= 2 ? data.readUInt16BE(0) : undefined;
				const commandName =
					Object.entries(COMMANDS).find(([k, v]) => v === command)?.[0] ||
					command.toString(16);
				console.debug(
					`[CalrecClient] Sending commandQueue command: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? `, faderId: ${faderId}` : ""}`,
				);
				this.socket.write(buildPacket(command, data));
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

	private async getConsoleInfoInternal(): Promise<ConsoleInfo | null> {
		try {
			const result = await Promise.race([
				this.sendCommand(COMMANDS.READ_CONSOLE_INFO),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("Console info timeout")),
						this.settings.initializationTimeoutMs,
					),
				),
			]);
			return result as ConsoleInfo;
		} catch (error) {
			console.debug(
				`[CalrecClient] Console info request failed or timed out: ${error}`,
			);
			return null;
		}
	}

	private async getConsoleNameInternal(): Promise<string | null> {
		try {
			const result = await Promise.race([
				this.sendCommand(COMMANDS.READ_CONSOLE_NAME),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("Console name timeout")),
						this.settings.initializationTimeoutMs,
					),
				),
			]);
			return result as string;
		} catch (error) {
			console.debug(
				`[CalrecClient] Console name request failed or timed out: ${error}`,
			);
			return null;
		}
	}

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

		// Check if we have console info and validate against max faders
		if (this.state.consoleInfo && faderId > this.state.consoleInfo.maxFaders) {
			throw new Error(
				`Fader ID ${faderId} exceeds maximum faders (${this.state.consoleInfo.maxFaders}) for this console.`,
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

		// Check if we have console info and validate against max faders
		if (this.state.consoleInfo && faderId > this.state.consoleInfo.maxFaders) {
			throw new Error(
				`Fader ID ${faderId} exceeds maximum faders (${this.state.consoleInfo.maxFaders}) for this console.`,
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

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 20) {
				throw new Error(
					`Available aux commands require protocol version 20 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

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

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 21) {
				throw new Error(
					`Available mains commands require protocol version 21 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

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

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 20) {
				throw new Error(
					`Aux send routing commands require protocol version 20 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

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
	 * Get routing to a main bus (V21+).
	 * @param mainId The main bus ID.
	 * @returns Promise resolving to array of booleans for each fader route.
	 */
	public async getRouteToMain(mainId: number): Promise<boolean[]> {
		this.ensureConnected();

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 21) {
				throw new Error(
					`Route to main commands require protocol version 21 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

		const data = Buffer.alloc(2);
		data.writeUInt16BE(mainId, 0);
		const result = await this.sendCommand(COMMANDS.READ_ROUTE_TO_MAIN, data);

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

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 21) {
				throw new Error(
					`Stereo image commands require protocol version 21 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

		// Validate fader ID
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
			);
		}

		// Check if we have console info and validate against max faders
		if (this.state.consoleInfo && faderId > this.state.consoleInfo.maxFaders) {
			throw new Error(
				`Fader ID ${faderId} exceeds maximum faders (${this.state.consoleInfo.maxFaders}) for this console.`,
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

		// Check if we have console info and validate protocol version
		if (this.state.consoleInfo) {
			if (this.state.consoleInfo.protocolVersion < 21) {
				throw new Error(
					`Stereo image commands require protocol version 21 or higher. Console version: ${this.state.consoleInfo.protocolVersion}`,
				);
			}
		}

		// Validate fader ID
		if (faderId < 1 || faderId > this.getEffectiveMaxFaderCount()) {
			throw new Error(
				`Invalid fader ID: ${faderId}. Must be between 1 and ${this.getEffectiveMaxFaderCount()}.`,
			);
		}

		// Check if we have console info and validate against max faders
		if (this.state.consoleInfo && faderId > this.state.consoleInfo.maxFaders) {
			throw new Error(
				`Fader ID ${faderId} exceeds maximum faders (${this.state.consoleInfo.maxFaders}) for this console.`,
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
	 * Get the effective maximum fader count based on console info or manual override.
	 * @returns The maximum number of faders to use for validation and array sizing.
	 */
	private getEffectiveMaxFaderCount(): number {
		// If we have console info, use that as the authoritative source
		if (this.state.consoleInfo) {
			return this.state.consoleInfo.maxFaders;
		}

		// Otherwise, use the manually specified maxFaderCount or default to 42
		return this.maxFaderCount || 42;
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
	 * Wait for console info to be available, with optional timeout.
	 * This ensures that the dynamic fader count is based on actual console capabilities.
	 * @param timeoutMs Optional timeout in milliseconds (default: 5000ms)
	 * @returns Promise that resolves when console info is available or timeout is reached
	 */
	public async waitForConsoleInfo(
		timeoutMs: number = 5000,
	): Promise<ConsoleInfo | null> {
		// If we already have console info, return it immediately
		if (this.state.consoleInfo) {
			return this.state.consoleInfo;
		}

		// If not connected, throw an error
		if (this.state.connectionState !== ConnectionState.CONNECTED) {
			throw new Error("Client is not connected. Call connect() first.");
		}

		// Wait for console info to become available
		return new Promise<ConsoleInfo | null>((resolve) => {
			const timeout = setTimeout(() => {
				console.debug(
					`[CalrecClient] waitForConsoleInfo timeout after ${timeoutMs}ms`,
				);
				resolve(null);
			}, timeoutMs);

			// Check if console info becomes available
			const checkConsoleInfo = () => {
				if (this.state.consoleInfo) {
					clearTimeout(timeout);
					resolve(this.state.consoleInfo);
				} else {
					// Check again in 100ms
					setTimeout(checkConsoleInfo, 100);
				}
			};

			checkConsoleInfo();
		});
	}

	/**
	 * Get the effective maximum fader count, ensuring console info is available first.
	 * This method will wait for console info if it's not already available.
	 * @param waitForConsoleInfo Whether to wait for console info if not available (default: false)
	 * @param timeoutMs Timeout for waiting for console info (default: 5000ms)
	 * @returns Promise resolving to the maximum number of faders
	 */
	public async getMaxFaderCountAsync(
		waitForConsoleInfo: boolean = false,
		timeoutMs: number = 5000,
	): Promise<number> {
		if (waitForConsoleInfo && !this.state.consoleInfo) {
			const consoleInfo = await this.waitForConsoleInfo(timeoutMs);
			if (consoleInfo) {
				return consoleInfo.maxFaders;
			}
		}

		return this.getEffectiveMaxFaderCount();
	}

	/**
	 * Get the effective maximum main count based on console info.
	 * @returns The maximum number of mains to use for validation and array sizing.
	 */
	private getEffectiveMaxMainCount(): number {
		// If we have console info, use that as the authoritative source
		if (this.state.consoleInfo) {
			return this.state.consoleInfo.maxMains;
		}

		// Default to 16 if no console info available
		return 16;
	}
}
