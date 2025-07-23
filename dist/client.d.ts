import { EventEmitter } from "node:events";
import { type CalrecClientEvents, type CalrecClientOptions, ConnectionState, type ConsoleInfo, type ClientState, type FaderAssignment, type StereoImage } from "./types";
export declare class CalrecClient extends EventEmitter {
    private options;
    private socket;
    private state;
    private reconnectTimeout;
    private dataBuffer;
    private commandQueue;
    private faderLevelQueue;
    private isProcessing;
    private lastFaderLevelSent;
    private lastCommandSent;
    private requestMap;
    private commandResponseQueue;
    private commandInFlight;
    private maxFaderCount?;
    constructor(options: CalrecClientOptions);
    on<K extends keyof CalrecClientEvents>(event: K, listener: CalrecClientEvents[K]): this;
    once<K extends keyof CalrecClientEvents>(event: K, listener: CalrecClientEvents[K]): this;
    emit<K extends keyof CalrecClientEvents>(event: K, ...args: Parameters<CalrecClientEvents[K]>): boolean;
    private setState;
    getState(): ClientState;
    getConnectionState(): ConnectionState;
    private ensureConnected;
    /**
     * Connects to the Calrec console.
     */
    connect(): void;
    private handleDisconnect;
    /**
     * Disconnects from the Calrec console and disables auto-reconnect for this instance.
     */
    disconnect(): void;
    private handleData;
    private processIncomingMessage;
    private parseResponseData;
    private emitUnsolicitedEvent;
    private enqueueCommandWithResponse;
    private dequeueNextCommand;
    private sendCommand;
    private sendCommandWithQueue;
    private processCommandQueue;
    private getConsoleInfoInternal;
    private getConsoleNameInternal;
    getConsoleInfo(): Promise<ConsoleInfo>;
    getConsoleName(): Promise<string>;
    setFaderLevel(faderId: number, level: number): Promise<void>;
    getFaderLevel(faderId: number): Promise<number>;
    setFaderCut(faderId: number, isCut: boolean): Promise<void>;
    getFaderLabel(faderId: number): Promise<string>;
    setAuxRouting(auxId: number, routes: boolean[]): Promise<void>;
    setFaderPfl(faderId: number, isPfl: boolean): Promise<void>;
    setMainFaderPfl(mainId: number, isPfl: boolean): Promise<void>;
    setAuxOutputLevel(auxId: number, level: number): Promise<void>;
    getAuxOutputLevel(auxId: number): Promise<number>;
    setRouteToMain(mainId: number, routes: boolean[]): Promise<void>;
    setStereoImage(faderId: number, image: {
        leftToBoth: boolean;
        rightToBoth: boolean;
    }): Promise<void>;
    getFaderAssignment(faderId: number): Promise<FaderAssignment>;
    getStereoImage(faderId: number): Promise<StereoImage>;
    /**
     * Sets a fader level using decibels (dB) instead of raw protocol levels.
     * Uses channel fader conversion curve.
     * @param faderId The fader ID.
     * @param db The decibel value (typically -100 to +10 dB for channel faders).
     * @returns Promise that resolves when the command is sent.
     */
    setFaderLevelDb(faderId: number, db: number): Promise<void>;
    /**
     * Gets a fader level in decibels (dB) instead of raw protocol levels.
     * Uses channel fader conversion curve.
     * @param faderId The fader ID.
     * @returns Promise that resolves to the decibel value.
     */
    getFaderLevelDb(faderId: number): Promise<number>;
    /**
     * Sets a main fader level using decibels (dB) instead of raw protocol levels.
     * Uses main fader conversion curve.
     * @param faderId The main fader ID.
     * @param db The decibel value (typically -100 to 0 dB for main faders).
     * @returns Promise that resolves when the command is sent.
     */
    setMainFaderLevelDb(faderId: number, db: number): Promise<void>;
    /**
     * Gets a main fader level in decibels (dB) instead of raw protocol levels.
     * Uses main fader conversion curve.
     * @param faderId The main fader ID.
     * @returns Promise that resolves to the decibel value.
     */
    getMainFaderLevelDb(faderId: number): Promise<number>;
}
//# sourceMappingURL=client.d.ts.map