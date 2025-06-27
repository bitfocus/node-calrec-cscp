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
} from "./types";
import {
	dbToChannelLevel,
	dbToMainLevel,
	channelLevelToDb,
	mainLevelToDb,
} from "./converters";

const SOH = 0xf1;
const COMMAND_BURST_RATE_MS = 20;
const COMMAND_BURST_AMOUNT = 3;
const FADER_LEVEL_RATE_MS = 100; // 10 per second

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
	private options: Required<CalrecClientOptions>;
	private socket: net.Socket | null = null;
	private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
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
	private requestMap = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (reason?: Error) => void }
	>();

	constructor(options: CalrecClientOptions) {
		super();
		this.options = {
			autoReconnect: true,
			reconnectInterval: 5000,
			...options,
		};
		this.setConnectionState(ConnectionState.DISCONNECTED);
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

	private setConnectionState(newState: ConnectionState) {
		if (this.connectionState !== newState) {
			this.connectionState = newState;
			this.emit("connectionStateChange", this.connectionState);
		}
	}

	public getState(): ConnectionState {
		return this.connectionState;
	}

	/**
	 * Connects to the Calrec console.
	 */
	public connect(): void {
		if (this.socket || this.connectionState === ConnectionState.CONNECTING) {
			return;
		}

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		this.setConnectionState(ConnectionState.CONNECTING);
		this.socket = new net.Socket();
		this.socket.connect(this.options.port, this.options.host, () => {
			this.setConnectionState(ConnectionState.CONNECTED);
			this.emit("connect");
			this.processCommandQueue();
			this.getConsoleInfo()
				.then(() => this.emit("ready"))
				.catch((e) => this.emit("error", e));
		});

		this.socket.on("data", this.handleData.bind(this));
		this.socket.on("close", this.handleDisconnect.bind(this));
		this.socket.on("error", (err) => {
			this.emit("error", err);
		});
	}

	private handleDisconnect(): void {
		this.socket?.destroy();
		this.socket = null;
		this.emit("disconnect");

		if (this.connectionState !== ConnectionState.DISCONNECTED) {
			this.setConnectionState(ConnectionState.DISCONNECTED);
		}

		if (this.options.autoReconnect) {
			this.setConnectionState(ConnectionState.RECONNECTING);
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
					this.emit("error", new Error(errorMessage));
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
			default:
				this.emit("unsolicitedMessage", { command, data });
		}
	}

	private async processCommandQueue(): Promise<void> {
		if (this.isProcessing || this.connectionState !== ConnectionState.CONNECTED)
			return;
		this.isProcessing = true;

		if (!this.socket) {
			this.isProcessing = false;
			return;
		}

		if (
			this.faderLevelQueue.length > 0 &&
			Date.now() - this.lastFaderLevelSent > FADER_LEVEL_RATE_MS
		) {
			const nextFaderCommand = this.faderLevelQueue.shift();
			if (nextFaderCommand) {
				const { command, data } = nextFaderCommand;
				this.socket.write(buildPacket(command, data));
				this.lastFaderLevelSent = Date.now();
			}
		} else if (this.commandQueue.length > 0) {
			const commandsToSend = this.commandQueue.splice(0, COMMAND_BURST_AMOUNT);
			for (const { command, data } of commandsToSend) {
				this.socket.write(buildPacket(command, data));
			}
		}

		this.isProcessing = false;

		if (this.commandQueue.length > 0 || this.faderLevelQueue.length > 0) {
			setTimeout(() => this.processCommandQueue(), COMMAND_BURST_RATE_MS);
		}
	}

	private sendCommand<T>(
		command: number,
		data: Buffer = Buffer.alloc(0),
		isFaderLevel = false,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.connectionState !== ConnectionState.CONNECTED) {
				return reject(new Error("Not connected to the console."));
			}
			const queue = isFaderLevel ? this.faderLevelQueue : this.commandQueue;
			queue.push({
				command,
				data,
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			// If it is a read command, set up the promise resolver
			if ((command & 0x8000) === 0) {
				let requestKey = `${command}`;
				if (data.length >= 2) {
					requestKey = `${command}:${data.readUInt16BE(0)}`;
				}
				this.requestMap.set(requestKey, {
					resolve: resolve as (value: unknown) => void,
					reject,
				});
				setTimeout(() => {
					if (this.requestMap.has(requestKey)) {
						this.requestMap.delete(requestKey);
						reject(
							new Error(`Request for command ${command.toString(16)} timed out.`),
						);
					}
				}, 5000);
			} else {
				// For write commands, resolve immediately
				resolve(undefined as T);
			}

			if (!this.isProcessing) {
				this.processCommandQueue();
			}
		});
	}

	// --- PUBLIC API METHODS ---

	public getConsoleInfo(): Promise<ConsoleInfo> {
		return this.sendCommand(COMMANDS.READ_CONSOLE_INFO);
	}

	public getConsoleName(): Promise<string> {
		return this.sendCommand(COMMANDS.READ_CONSOLE_NAME);
	}

	public setFaderLevel(faderId: number, level: number): Promise<void> {
		const data = Buffer.alloc(4);
		data.writeUInt16BE(faderId, 0);
		data.writeUInt16BE(Math.min(1023, Math.max(0, level)), 2);
		return this.sendCommand(COMMANDS.WRITE_FADER_LEVEL, data, true);
	}

	public getFaderLevel(faderId: number): Promise<number> {
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		return this.sendCommand(COMMANDS.READ_FADER_LEVEL, data);
	}

	public setFaderCut(faderId: number, isCut: boolean): Promise<void> {
		const data = Buffer.alloc(3);
		data.writeUInt16BE(faderId, 0);
		data[2] = isCut ? 0 : 1;
		return this.sendCommand(COMMANDS.WRITE_FADER_CUT, data);
	}

	public getFaderLabel(faderId: number): Promise<string> {
		const data = Buffer.alloc(2);
		data.writeUInt16BE(faderId, 0);
		return this.sendCommand(COMMANDS.READ_FADER_LABEL, data);
	}

	public setAuxRouting(auxId: number, routes: boolean[]): Promise<void> {
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

	// --- DECIBEL CONVERSION METHODS ---

	/**
	 * Sets a fader level using decibels (dB) instead of raw protocol levels.
	 * Uses channel fader conversion curve.
	 * @param faderId The fader ID.
	 * @param db The decibel value (typically -100 to +10 dB for channel faders).
	 * @returns Promise that resolves when the command is sent.
	 */
	public setFaderLevelDb(faderId: number, db: number): Promise<void> {
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
		const level = await this.getFaderLevel(faderId);
		return mainLevelToDb(level);
	}
}