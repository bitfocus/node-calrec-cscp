"use strict";
// src/client.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalrecClient = void 0;
const node_events_1 = require("node:events");
const net = __importStar(require("node:net"));
const protocol_1 = require("./protocol");
const types_1 = require("./types");
const converters_1 = require("./converters");
const SOH = 0xf1;
const COMMAND_BURST_RATE_MS = 20;
const COMMAND_BURST_AMOUNT = 3;
const FADER_LEVEL_RATE_MS = 100; // 10 per second
function parseNakError(errorCode) {
    const errors = [];
    if (errorCode & types_1.NakError.COMMAND_NOT_SUPPORTED)
        errors.push("Command Not Supported");
    if (errorCode & types_1.NakError.TIMEOUT)
        errors.push("Timeout");
    if (errorCode & types_1.NakError.UNDEFINED_ERROR)
        errors.push("Undefined Error");
    if (errorCode & types_1.NakError.INTERFACE_ERROR)
        errors.push("Interface Error");
    if (errorCode & types_1.NakError.BYTE_COUNT_ERROR)
        errors.push("Byte Count Error");
    if (errorCode & types_1.NakError.CHECKSUM_ERROR)
        errors.push("Checksum Error");
    if (errorCode & types_1.NakError.PROTOCOL_ERROR)
        errors.push("Protocol Error");
    return `Received NAK with error(s): ${errors.join(", ") || "Unknown Error"}`;
}
class CalrecClient extends node_events_1.EventEmitter {
    constructor(options) {
        super();
        this.socket = null;
        this.state = {
            connectionState: types_1.ConnectionState.DISCONNECTED,
            consoleInfo: null,
            consoleName: null,
        };
        this.reconnectTimeout = null;
        this.dataBuffer = Buffer.alloc(0);
        this.commandQueue = [];
        this.faderLevelQueue = [];
        this.isProcessing = false;
        this.lastFaderLevelSent = 0;
        this.requestMap = new Map();
        this.options = {
            autoReconnect: true,
            reconnectInterval: 5000,
            ...options,
        };
        this.setState({ connectionState: types_1.ConnectionState.DISCONNECTED });
    }
    // Safely override EventEmitter methods with strong types
    on(event, listener) {
        return super.on(event, listener);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    setState(newState) {
        const oldState = { ...this.state };
        this.state = { ...this.state, ...newState };
        // Emit connection state change if it changed
        if (oldState.connectionState !== this.state.connectionState) {
            this.emit("connectionStateChange", this.state.connectionState);
        }
    }
    getState() {
        return { ...this.state };
    }
    getConnectionState() {
        return this.state.connectionState;
    }
    ensureConnected() {
        if (this.state.connectionState !== types_1.ConnectionState.CONNECTED) {
            throw new Error(`Client is not connected. Current state: ${this.state.connectionState}`);
        }
        if (!this.state.consoleInfo || !this.state.consoleName) {
            throw new Error("Client is not fully initialized. Console info and name are required.");
        }
    }
    /**
     * Connects to the Calrec console.
     */
    connect() {
        if (this.socket ||
            this.state.connectionState === types_1.ConnectionState.CONNECTING) {
            return;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.setState({
            connectionState: types_1.ConnectionState.CONNECTING,
            consoleInfo: null,
            consoleName: null,
        });
        this.socket = new net.Socket();
        this.socket.connect(this.options.port, this.options.host, async () => {
            this.setState({ connectionState: types_1.ConnectionState.CONNECTED });
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
            }
            catch (error) {
                this.setState({ connectionState: types_1.ConnectionState.ERROR });
                this.emit("error", error);
            }
        });
        this.socket.on("data", this.handleData.bind(this));
        this.socket.on("close", this.handleDisconnect.bind(this));
        this.socket.on("error", (err) => {
            this.setState({ connectionState: types_1.ConnectionState.ERROR });
            this.emit("error", err);
        });
    }
    handleDisconnect() {
        this.socket?.destroy();
        this.socket = null;
        this.emit("disconnect");
        if (this.state.connectionState !== types_1.ConnectionState.DISCONNECTED) {
            this.setState({
                connectionState: types_1.ConnectionState.DISCONNECTED,
                consoleInfo: null,
                consoleName: null,
            });
        }
        if (this.options.autoReconnect) {
            this.setState({ connectionState: types_1.ConnectionState.RECONNECTING });
            this.reconnectTimeout = setTimeout(() => this.connect(), this.options.reconnectInterval);
        }
    }
    /**
     * Disconnects from the Calrec console and disables auto-reconnect for this instance.
     */
    disconnect() {
        this.options.autoReconnect = false; // User-initiated disconnect should not reconnect
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.handleDisconnect();
    }
    handleData(chunk) {
        this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);
        if (this.dataBuffer.length > 0) {
            if (this.dataBuffer[0] === protocol_1.ACK) {
                this.dataBuffer = this.dataBuffer.slice(1);
                return;
            }
            if (this.dataBuffer[0] === protocol_1.NAK) {
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
            if (this.dataBuffer.length < 4)
                return;
            const byteCount = this.dataBuffer[1];
            const messageLength = byteCount + 4;
            if (this.dataBuffer.length < messageLength)
                return;
            const packetWithSoh = this.dataBuffer.slice(0, messageLength);
            const messageBufferForParser = packetWithSoh.slice(1);
            this.dataBuffer = this.dataBuffer.slice(messageLength);
            const parsed = (0, protocol_1.parsePacket)(messageBufferForParser);
            if (parsed instanceof Error) {
                this.emit("error", parsed);
            }
            else {
                this.processIncomingMessage(parsed);
            }
        }
    }
    processIncomingMessage(message) {
        const { command, data } = message;
        const readCmd = command & 0x7fff;
        let requestKey = `${readCmd}`;
        // Global commands (like getConsoleInfo) don't have an ID in their request,
        // so their key is just the command number.
        // ID-specific commands (like getFaderLevel) need the ID appended to the key.
        const isIdSpecificCommand = ![
            protocol_1.COMMANDS.READ_CONSOLE_INFO,
            protocol_1.COMMANDS.READ_CONSOLE_NAME,
            protocol_1.COMMANDS.READ_AVAILABLE_AUX,
            protocol_1.COMMANDS.READ_AVAILABLE_MAINS,
            protocol_1.COMMANDS.READ_STEREO_IMAGE,
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
    parseResponseData(command, data) {
        const writeCommand = command | 0x8000;
        switch (writeCommand) {
            case protocol_1.COMMANDS.WRITE_FADER_LEVEL:
            case protocol_1.COMMANDS.WRITE_AUX_OUTPUT_LEVEL:
                return data.readUInt16BE(2);
            case protocol_1.COMMANDS.WRITE_FADER_CUT:
                return data[2] === 0;
            case protocol_1.COMMANDS.WRITE_FADER_PFL:
            case protocol_1.COMMANDS.WRITE_MAIN_PFL:
                return data[2] === 1;
            case protocol_1.COMMANDS.READ_CONSOLE_NAME:
                return data.toString("ascii");
            case protocol_1.COMMANDS.READ_FADER_LABEL:
            case protocol_1.COMMANDS.READ_MAIN_FADER_LABEL:
                return data.slice(2).toString("ascii");
            case protocol_1.COMMANDS.READ_CONSOLE_INFO:
                // Data for console info doesn't start with the ID, so we parse from the beginning
                return {
                    protocolVersion: data.readUInt16BE(0),
                    maxFaders: data.readUInt16BE(2),
                    maxMains: data.readUInt16BE(4),
                    deskLabel: data.slice(12, 20).toString("ascii").trim(),
                };
            default:
                return data;
        }
    }
    emitUnsolicitedEvent(command, data) {
        const id = data.length >= 2 ? data.readUInt16BE(0) : -1;
        switch (command) {
            case protocol_1.COMMANDS.WRITE_FADER_LEVEL:
                this.emit("faderLevelChange", id, data.readUInt16BE(2));
                break;
            case protocol_1.COMMANDS.WRITE_FADER_CUT:
                this.emit("faderCutChange", id, data[2] === 0);
                break;
            case protocol_1.COMMANDS.WRITE_FADER_PFL:
                this.emit("faderPflChange", id, data[2] === 1);
                break;
            default:
                this.emit("unsolicitedMessage", { command, data });
        }
    }
    async processCommandQueue() {
        if (this.isProcessing ||
            this.state.connectionState !== types_1.ConnectionState.CONNECTED)
            return;
        this.isProcessing = true;
        if (!this.socket) {
            this.isProcessing = false;
            return;
        }
        if (this.faderLevelQueue.length > 0 &&
            Date.now() - this.lastFaderLevelSent > FADER_LEVEL_RATE_MS) {
            const nextFaderCommand = this.faderLevelQueue.shift();
            if (nextFaderCommand) {
                const { command, data } = nextFaderCommand;
                this.socket.write((0, protocol_1.buildPacket)(command, data));
                this.lastFaderLevelSent = Date.now();
            }
        }
        else if (this.commandQueue.length > 0) {
            const commandsToSend = this.commandQueue.splice(0, COMMAND_BURST_AMOUNT);
            for (const { command, data } of commandsToSend) {
                this.socket.write((0, protocol_1.buildPacket)(command, data));
            }
        }
        this.isProcessing = false;
        if (this.commandQueue.length > 0 || this.faderLevelQueue.length > 0) {
            setTimeout(() => this.processCommandQueue(), COMMAND_BURST_RATE_MS);
        }
    }
    sendCommand(command, data = Buffer.alloc(0), isFaderLevel = false) {
        return new Promise((resolve, reject) => {
            if (this.state.connectionState !== types_1.ConnectionState.CONNECTED) {
                return reject(new Error("Not connected to the console."));
            }
            const queue = isFaderLevel ? this.faderLevelQueue : this.commandQueue;
            queue.push({
                command,
                data,
                resolve: resolve,
                reject,
            });
            // If it is a read command, set up the promise resolver
            if ((command & 0x8000) === 0) {
                let requestKey = `${command}`;
                if (data.length >= 2) {
                    requestKey = `${command}:${data.readUInt16BE(0)}`;
                }
                this.requestMap.set(requestKey, {
                    resolve: resolve,
                    reject,
                });
                setTimeout(() => {
                    if (this.requestMap.has(requestKey)) {
                        this.requestMap.delete(requestKey);
                        reject(new Error(`Request for command ${command.toString(16)} timed out.`));
                    }
                }, 5000);
            }
            else {
                // For write commands, resolve immediately
                resolve(undefined);
            }
            if (!this.isProcessing) {
                this.processCommandQueue();
            }
        });
    }
    // --- PUBLIC API METHODS ---
    async getConsoleInfoInternal() {
        return this.sendCommand(protocol_1.COMMANDS.READ_CONSOLE_INFO);
    }
    async getConsoleNameInternal() {
        return this.sendCommand(protocol_1.COMMANDS.READ_CONSOLE_NAME);
    }
    getConsoleInfo() {
        this.ensureConnected();
        return this.sendCommand(protocol_1.COMMANDS.READ_CONSOLE_INFO);
    }
    getConsoleName() {
        this.ensureConnected();
        return this.sendCommand(protocol_1.COMMANDS.READ_CONSOLE_NAME);
    }
    setFaderLevel(faderId, level) {
        this.ensureConnected();
        const data = Buffer.alloc(4);
        data.writeUInt16BE(faderId, 0);
        data.writeUInt16BE(Math.min(1023, Math.max(0, level)), 2);
        return this.sendCommand(protocol_1.COMMANDS.WRITE_FADER_LEVEL, data, true);
    }
    getFaderLevel(faderId) {
        this.ensureConnected();
        const data = Buffer.alloc(2);
        data.writeUInt16BE(faderId, 0);
        return this.sendCommand(protocol_1.COMMANDS.READ_FADER_LEVEL, data);
    }
    setFaderCut(faderId, isCut) {
        this.ensureConnected();
        const data = Buffer.alloc(3);
        data.writeUInt16BE(faderId, 0);
        data[2] = isCut ? 0 : 1;
        return this.sendCommand(protocol_1.COMMANDS.WRITE_FADER_CUT, data);
    }
    getFaderLabel(faderId) {
        this.ensureConnected();
        const data = Buffer.alloc(2);
        data.writeUInt16BE(faderId, 0);
        return this.sendCommand(protocol_1.COMMANDS.READ_FADER_LABEL, data);
    }
    setAuxRouting(auxId, routes) {
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
        return this.sendCommand(protocol_1.COMMANDS.WRITE_AUX_SEND_ROUTING, data);
    }
    // --- DECIBEL CONVERSION METHODS ---
    /**
     * Sets a fader level using decibels (dB) instead of raw protocol levels.
     * Uses channel fader conversion curve.
     * @param faderId The fader ID.
     * @param db The decibel value (typically -100 to +10 dB for channel faders).
     * @returns Promise that resolves when the command is sent.
     */
    setFaderLevelDb(faderId, db) {
        this.ensureConnected();
        const level = (0, converters_1.dbToChannelLevel)(db);
        return this.setFaderLevel(faderId, level);
    }
    /**
     * Gets a fader level in decibels (dB) instead of raw protocol levels.
     * Uses channel fader conversion curve.
     * @param faderId The fader ID.
     * @returns Promise that resolves to the decibel value.
     */
    async getFaderLevelDb(faderId) {
        this.ensureConnected();
        const level = await this.getFaderLevel(faderId);
        return (0, converters_1.channelLevelToDb)(level);
    }
    /**
     * Sets a main fader level using decibels (dB) instead of raw protocol levels.
     * Uses main fader conversion curve.
     * @param faderId The main fader ID.
     * @param db The decibel value (typically -100 to 0 dB for main faders).
     * @returns Promise that resolves when the command is sent.
     */
    setMainFaderLevelDb(faderId, db) {
        this.ensureConnected();
        const level = (0, converters_1.dbToMainLevel)(db);
        return this.setFaderLevel(faderId, level);
    }
    /**
     * Gets a main fader level in decibels (dB) instead of raw protocol levels.
     * Uses main fader conversion curve.
     * @param faderId The main fader ID.
     * @returns Promise that resolves to the decibel value.
     */
    async getMainFaderLevelDb(faderId) {
        this.ensureConnected();
        const level = await this.getFaderLevel(faderId);
        return (0, converters_1.mainLevelToDb)(level);
    }
}
exports.CalrecClient = CalrecClient;
//# sourceMappingURL=client.js.map