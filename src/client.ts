// src/client.ts

import { EventEmitter } from "node:events";
import * as net from "node:net";
import { ACK, buildPacket, COMMANDS, NAK, parsePacket } from "./protocol";
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

const SOH = 0xf1;
const FADER_LEVEL_RATE_MS = 100; // 10 per second
const COMMAND_RESPONSE_TIMEOUT_MS = 100; // Timeout for command responses in ms
const LABEL_FETCH_MAX_RETRIES = 5; // Max retries before marking label as failed
const LABEL_REFETCH_INTERVAL_MS = 60000; // Periodic refetch interval (1 min)
const GLOBAL_COMMAND_RATE_MS = 10; // Minimum 10ms between any command

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

	constructor(options: CalrecClientOptions) {
		super();
		const { maxFaderCount, ...rest } = options;
		this.options = {
			autoReconnect: true,
			reconnectInterval: 5000,
			...rest,
		};
		this.maxFaderCount = maxFaderCount;
		this.setState({ connectionState: ConnectionState.DISCONNECTED });
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

	public getState(): ClientState {
		return { ...this.state };
	}

	public getConnectionState(): ConnectionState {
		return this.state.connectionState;
	}

	private ensureConnected(): void {
		if (this.state.connectionState !== ConnectionState.CONNECTED) {
			throw new Error(
				`Client is not connected. Current state: ${this.state.connectionState}`,
			);
		}
		if (!this.state.consoleInfo || !this.state.consoleName) {
			throw new Error(
				"Client is not fully initialized. Console info and name are required.",
			);
		}
	}

	/**
	 * Connects to the Calrec console.
	 */
	public connect(): void {
		if (
			this.socket ||
			this.state.connectionState === ConnectionState.CONNECTING
		) {
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
		this.socket.connect(this.options.port, this.options.host, async () => {
			this.setState({ connectionState: ConnectionState.CONNECTED });
			this.emit("connect");
			this.processCommandQueue();

			try {
				// Get console info and name to complete initialization
				const [consoleInfo, consoleName] = await Promise.all([
					this.getConsoleInfoInternal(),
					this.getConsoleNameInternal(),
				]);

				this.setState({ consoleInfo, consoleName });
				this.emit("ready");
			} catch (error) {
				this.setState({ connectionState: ConnectionState.ERROR });
				this.emit("error", error as Error);
			}
		});

		this.socket.on("data", this.handleData.bind(this));
		this.socket.on("close", this.handleDisconnect.bind(this));
		this.socket.on("error", (err) => {
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
	 */
	public disconnect(): void {
		this.options.autoReconnect = false; // User-initiated disconnect should not reconnect
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.handleDisconnect();
	}

	private handleData(chunk: Buffer): void {
		this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);

		if (this.dataBuffer.length > 0) {
			if (this.dataBuffer[0] === ACK) {
				this.dataBuffer = this.dataBuffer.slice(1);
				return;
			}
			if (this.dataBuffer[0] === NAK) {
				if (this.dataBuffer.length > 1) {
					const errorCode = this.dataBuffer[1];
					const errorMessage = parseNakError(errorCode);
					// Try to reject the matching pending request
					let matched = false;
					for (const [requestKey, { reject }] of this.requestMap.entries()) {
						reject(new Error(`NAK: ${errorMessage}`));
						this.requestMap.delete(requestKey);
						matched = true;
						break; // Only reject one per NAK
					}
					if (!matched) {
						this.emit("error", new Error(errorMessage));
					}
					this.dataBuffer = this.dataBuffer.slice(2);
					return;
				}
				return;
			}
		}

		while (this.dataBuffer.length > 0) {
			const sohIndex = this.dataBuffer.indexOf(SOH);
			if (sohIndex === -1) {
				return;
			}
			if (sohIndex > 0) {
				this.dataBuffer = this.dataBuffer.slice(sohIndex);
			}

			if (this.dataBuffer.length < 4) return;

			const byteCount = this.dataBuffer[1];
			const messageLength = byteCount + 4;

			if (this.dataBuffer.length < messageLength) return;

			const packetWithSoh = this.dataBuffer.slice(0, messageLength);
			const messageBufferForParser = packetWithSoh.slice(1);

			this.dataBuffer = this.dataBuffer.slice(messageLength);

			const parsed = parsePacket(messageBufferForParser);

			if (parsed instanceof Error) {
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
		].includes(readCmd);

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

		this.emitUnsolicitedEvent(command, data);
	}

	private parseResponseData(command: number, data: Buffer): unknown {
		const writeCommand = command | 0x8000;
		switch (writeCommand) {
			case COMMANDS.WRITE_FADER_LEVEL:
			case COMMANDS.WRITE_AUX_OUTPUT_LEVEL:
				return data.readUInt16BE(2);
			case COMMANDS.WRITE_FADER_CUT:
				return data[2] === 0;
			case COMMANDS.WRITE_FADER_PFL:
			case COMMANDS.WRITE_MAIN_PFL:
				return data[2] === 1;
			case COMMANDS.READ_CONSOLE_NAME:
				return data.toString("ascii");
			case COMMANDS.READ_FADER_LABEL:
			case COMMANDS.READ_MAIN_FADER_LABEL:
				return data.slice(2).toString("ascii");
			case COMMANDS.READ_CONSOLE_INFO:
				// Data for console info doesn't start with the ID, so we parse from the beginning
				return {
					protocolVersion: data.readUInt16BE(0),
					maxFaders: data.readUInt16BE(2),
					maxMains: data.readUInt16BE(4),
					deskLabel: data.slice(12, 20).toString("ascii").trim(),
				} as ConsoleInfo;
			default:
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
			case COMMANDS.READ_FADER_LABEL: {
				const labelBuf = data.slice(2);
				const labelStr = Buffer.isBuffer(labelBuf) ? labelBuf.toString('utf8') : String(labelBuf);
				this.emit("faderLabelChange", id, labelStr);
				break;
			}
			case COMMANDS.READ_MAIN_FADER_LABEL: {
				const labelBuf = data.slice(2);
				const labelStr = Buffer.isBuffer(labelBuf) ? labelBuf.toString('utf8') : String(labelBuf);
				this.emit("mainLabelChange", id, labelStr);
				break;
			}
			default:
				this.emit("unsolicitedMessage", { command, data });
		}
	}

	private enqueueCommandWithResponse<T>(commandFn: () => Promise<T>): Promise<T> {
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
				return reject(new Error("Not connected to the console."));
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
						reject(
							new Error(
								`Request for command ${command.toString(16)} timed out after ${COMMAND_RESPONSE_TIMEOUT_MS}ms.`,
							),
						);
					}
				};
				setTimeout(handleCommandTimeout, COMMAND_RESPONSE_TIMEOUT_MS);
			} else {
				// For write commands, resolve immediately
				resolve(undefined as T);
			}

			if (!this.isProcessing) {
				this.processCommandQueue();
			}
		});
	}

	private sendCommandWithQueue<T>(command: number, data: Buffer = Buffer.alloc(0), isFaderLevel = false): Promise<T> {
		if ((command & 0x8000) === 0) {
			return this.enqueueCommandWithResponse(() => this.sendCommand<T>(command, data, isFaderLevel));
		} else {
			return this.sendCommand<T>(command, data, isFaderLevel);
		}
	}

	private async processCommandQueue(): Promise<void> {
		if (
			this.isProcessing ||
			this.state.connectionState !== ConnectionState.CONNECTED
		)
			return;
		this.isProcessing = true;

		if (!this.socket) {
			this.isProcessing = false;
			return;
		}

		const now = Date.now();
		const timeSinceLastCommand = now - this.lastCommandSent;
		if (timeSinceLastCommand < GLOBAL_COMMAND_RATE_MS) {
			this.isProcessing = false;
			setTimeout(() => this.processCommandQueue(), GLOBAL_COMMAND_RATE_MS - timeSinceLastCommand);
			return;
		}

		if (
			this.faderLevelQueue.length > 0 &&
			Date.now() - this.lastFaderLevelSent > FADER_LEVEL_RATE_MS
		) {
			const nextFaderCommand = this.faderLevelQueue.shift();
			if (nextFaderCommand) {
				const { command, data } = nextFaderCommand;
				const faderId = data.length >= 2 ? data.readUInt16BE(0) : undefined;
				const commandName = Object.entries(COMMANDS).find(([k, v]) => v === command)?.[0] || command.toString(16);
				console.debug(`[CalrecClient] Sending faderLevelQueue command: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? ", faderId: " + faderId : ""}`);
				this.socket.write(buildPacket(command, data));
				this.lastFaderLevelSent = Date.now();
				this.lastCommandSent = Date.now();
			}
		} else if (this.commandQueue.length > 0) {
			const nextCommand = this.commandQueue.shift();
			if (nextCommand) {
				const { command, data } = nextCommand;
				const faderId = data.length >= 2 ? data.readUInt16BE(0) : undefined;
				const commandName = Object.entries(COMMANDS).find(([k, v]) => v === command)?.[0] || command.toString(16);
				console.debug(`[CalrecClient] Sending commandQueue command: ${commandName} (0x${command.toString(16)})${faderId !== undefined ? ", faderId: " + faderId : ""}`);
				this.socket.write(buildPacket(command, data));
				this.lastCommandSent = Date.now();
			}
		}

		this.isProcessing = false;

		if (this.commandQueue.length > 0 || this.faderLevelQueue.length > 0) {
			setTimeout(() => this.processCommandQueue(), GLOBAL_COMMAND_RATE_MS);
		}
	}

	// --- PUBLIC API METHODS ---

	private async getConsoleInfoInternal(): Promise<ConsoleInfo> {
		return this.sendCommand(COMMANDS.READ_CONSOLE_INFO);
	}

	private async getConsoleNameInternal(): Promise<string> {
		return this.sendCommand(COMMANDS.READ_CONSOLE_NAME);
	}

	public getConsoleInfo(): Promise<ConsoleInfo> {
		this.ensureConnected();
		return this.sendCommand(COMMANDS.READ_CONSOLE_INFO);
	}

	public getConsoleName(): Promise<string> {
		this.ensureConnected();
		return this.sendCommand(COMMANDS.READ_CONSOLE_NAME);
	}

	public setFaderLevel(faderId: number, level: number): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(4);
		data.writeUInt16BE(faderId, 0);
		data.writeUInt16BE(Math.min(1023, Math.max(0, level)), 2);
		return this.sendCommand(COMMANDS.WRITE_FADER_LEVEL, data, true);
	}

	public getFaderLevel(faderId: number): Promise<number> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		return this.sendCommand(COMMANDS.READ_FADER_LEVEL, data);
	}

	public setFaderCut(faderId: number, isCut: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(faderId, 0);
		data[2] = isCut ? 0 : 1;
		return this.sendCommand(COMMANDS.WRITE_FADER_CUT, data);
	}

	public getFaderLabel(faderId: number): Promise<string> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		return this.sendCommandWithQueue(COMMANDS.READ_FADER_LABEL, data)
			.then((label) => {
				if (typeof label === "object" && label !== null && Buffer.isBuffer(label)) {
					return label.slice(2).toString("ascii");
				}
				return typeof label === "string" ? label : String(label);
			});
	}

	public setAuxRouting(auxId: number, routes: boolean[]): Promise<void> {
		this.ensureConnected();
		if (routes.length > 192)
			throw new Error("Maximum of 192 fader routes allowed.");
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
		return this.sendCommand(COMMANDS.WRITE_AUX_SEND_ROUTING, data);
	}

	public setFaderPfl(faderId: number, isPfl: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(faderId, 0);
		data[2] = isPfl ? 1 : 0;
		return this.sendCommand(COMMANDS.WRITE_FADER_PFL, data);
	}

	public setMainFaderPfl(mainId: number, isPfl: boolean): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(3);
		data.writeUInt16BE(mainId, 0);
		data[2] = isPfl ? 1 : 0;
		return this.sendCommand(COMMANDS.WRITE_MAIN_PFL, data);
	}

	public setAuxOutputLevel(auxId: number, level: number): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(4);
		data.writeUInt16BE(auxId, 0);
		data.writeUInt16BE(Math.min(1023, Math.max(0, level)), 2);
		return this.sendCommand(COMMANDS.WRITE_AUX_OUTPUT_LEVEL, data);
	}

	public getAuxOutputLevel(auxId: number): Promise<number> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(auxId, 0);
		return this.sendCommand(COMMANDS.READ_AUX_OUTPUT_LEVEL, data);
	}

	public setRouteToMain(mainId: number, routes: boolean[]): Promise<void> {
		this.ensureConnected();
		if (routes.length > 192)
			throw new Error("Maximum of 192 main routes allowed.");
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
		return this.sendCommand(COMMANDS.WRITE_ROUTE_TO_MAIN, data);
	}

	public setStereoImage(faderId: number, image: { leftToBoth: boolean; rightToBoth: boolean }): Promise<void> {
		this.ensureConnected();
		const data = Buffer.alloc(4);
		data.writeUInt16BE(faderId, 0);
		data[2] = image.leftToBoth ? 1 : 0;
		data[3] = image.rightToBoth ? 1 : 0;
		return this.sendCommand(COMMANDS.WRITE_STEREO_IMAGE, data);
	}

	public async getFaderAssignment(faderId: number): Promise<FaderAssignment> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		const result = await this.sendCommand(COMMANDS.READ_FADER_ASSIGNMENT, data);
		// Assume result is a Buffer and parse fields accordingly
		if (Buffer.isBuffer(result) && result.length >= 6) {
			return {
				faderId,
				type: result[2],
				width: result[3],
				calrecId: result.readUInt16BE(4),
			};
		}
		throw new Error("Invalid assignment data");
	}

	public async getStereoImage(faderId: number): Promise<StereoImage> {
		this.ensureConnected();
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		const result = await this.sendCommand(COMMANDS.READ_STEREO_IMAGE, data);
		if (Buffer.isBuffer(result) && result.length >= 4) {
			return {
				leftToBoth: !!result[2],
				rightToBoth: !!result[3],
			};
		}
		throw new Error("Invalid stereo image data");
	}

	// --- DECIBEL CONVERSION METHODS ---

	/**
	 * Sets a fader level using decibels (dB) instead of raw protocol levels.
	 * Uses channel fader conversion curve.
	 * @param faderId The fader ID.
	 * @param db The decibel value (typically -100 to +10 dB for channel faders).
	 * @returns Promise that resolves when the command is sent.
	 */
	public setFaderLevelDb(faderId: number, db: number): Promise<void> {
		this.ensureConnected();
		const level = dbToChannelLevel(db);
		return this.setFaderLevel(faderId, level);
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
	public setMainFaderLevelDb(faderId: number, db: number): Promise<void> {
		this.ensureConnected();
		const level = dbToMainLevel(db);
		return this.setFaderLevel(faderId, level);
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
}
