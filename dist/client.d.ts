import { EventEmitter } from "node:events";
import { type CalrecClientEvents, type CalrecClientOptions, ConnectionState, type ConsoleInfo, type ClientState, type FaderAssignment, type StereoImage } from "./types";
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
    private settings;
    constructor(options: CalrecClientOptions, settings?: CalrecClientSettings);
    /**
     * Update protocol timing/settings at runtime.
     * @param newSettings Partial settings to override current values.
     */
    updateSettings(newSettings: CalrecClientSettings): void;
    on<K extends keyof CalrecClientEvents>(event: K, listener: CalrecClientEvents[K]): this;
    once<K extends keyof CalrecClientEvents>(event: K, listener: CalrecClientEvents[K]): this;
    emit<K extends keyof CalrecClientEvents>(event: K, ...args: Parameters<CalrecClientEvents[K]>): boolean;
    private setState;
    /**
     * Connects to the Calrec console.
     * @returns Promise that resolves when the connection is established and the client is ready.
     */
    connect(): Promise<void>;
    private handleDisconnect;
    /**
     * Disconnects from the Calrec console and disables auto-reconnect for this instance.
     * @returns Promise that resolves when disconnected.
     */
    disconnect(): Promise<void>;
    private handleData;
    private processIncomingMessage;
    private parseResponseData;
    private emitUnsolicitedEvent;
    private parseRoutingData;
    private parseAvailableData;
    private parseFaderAssignmentData;
    private enqueueCommandWithResponse;
    private dequeueNextCommand;
    private sendCommand;
    private sendCommandWithQueue;
    private processCommandQueue;
    private getConsoleInfoInternal;
    private getConsoleNameInternal;
    /**
     * Get the current state of the client.
     * @returns A copy of the current client state.
     */
    getState(): ClientState;
    /**
     * Get the current connection state.
     * @returns The current connection state.
     */
    getConnectionState(): ConnectionState;
    /**
     * Throws if the client is not connected.
     * Used internally by all public API methods.
     */
    private ensureConnected;
    /**
     * Get information about the connected console.
     * @returns Promise resolving to ConsoleInfo.
     */
    getConsoleInfo(): Promise<ConsoleInfo>;
    /**
     * Get the name of the connected console.
     * @returns Promise resolving to the console name.
     */
    getConsoleName(): Promise<string>;
    /**
     * Set the fader level for a given fader.
     * @param faderId The fader ID.
     * @param level The protocol level (0-1023).
     * @returns Promise that resolves when the command is sent.
     */
    setFaderLevel(faderId: number, level: number): Promise<void>;
    /**
     * Get the fader level for a given fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the protocol level (0-1023).
     */
    getFaderLevel(faderId: number): Promise<number>;
    /**
     * Set the cut state for a fader.
     * @param faderId The fader ID.
     * @param isCut True to cut, false to uncut.
     * @returns Promise that resolves when the command is sent.
     */
    setFaderCut(faderId: number, isCut: boolean): Promise<void>;
    /**
     * Get the label for a fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the fader label.
     */
    getFaderLabel(faderId: number): Promise<string>;
    /**
     * Get the label for a main fader.
     * @param mainId The main fader ID.
     * @returns Promise resolving to the main fader label.
     */
    getMainFaderLabel(mainId: number): Promise<string>;
    /**
     * Get the cut state for a fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the cut state (true = cut, false = uncut).
     */
    getFaderCut(faderId: number): Promise<boolean>;
    /**
     * Get the PFL state for a fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the PFL state (true = PFL on, false = PFL off).
     */
    getFaderPfl(faderId: number): Promise<boolean>;
    /**
     * Get the PFL state for a main fader.
     * @param mainId The main fader ID.
     * @returns Promise resolving to the PFL state (true = PFL on, false = PFL off).
     */
    getMainPfl(mainId: number): Promise<boolean>;
    /**
     * Get available auxiliary outputs (V20+).
     * @returns Promise resolving to array of booleans indicating available auxes.
     */
    getAvailableAux(): Promise<boolean[]>;
    /**
     * Get available main outputs (V21+).
     * @returns Promise resolving to array of booleans indicating available mains.
     */
    getAvailableMains(): Promise<boolean[]>;
    /**
     * Get aux routing for an aux bus (V20+).
     * @param auxId The aux bus ID.
     * @returns Promise resolving to array of booleans for each fader route.
     */
    getAuxSendRouting(auxId: number): Promise<boolean[]>;
    /**
     * Get routing to a main bus (V21+).
     * @param mainId The main bus ID.
     * @returns Promise resolving to array of booleans for each fader route.
     */
    getRouteToMain(mainId: number): Promise<boolean[]>;
    /**
     * Set aux routing for an aux bus.
     * @param auxId The aux bus ID.
     * @param routes Array of booleans for each fader.
     * @returns Promise that resolves when the command is sent.
     */
    setAuxRouting(auxId: number, routes: boolean[]): Promise<void>;
    /**
     * Set the PFL (pre-fade listen) state for a fader.
     * @param faderId The fader ID.
     * @param isPfl True to enable PFL, false to disable.
     * @returns Promise that resolves when the command is sent.
     */
    setFaderPfl(faderId: number, isPfl: boolean): Promise<void>;
    /**
     * Set the PFL (pre-fade listen) state for a main fader.
     * @param mainId The main fader ID.
     * @param isPfl True to enable PFL, false to disable.
     * @returns Promise that resolves when the command is sent.
     */
    setMainFaderPfl(mainId: number, isPfl: boolean): Promise<void>;
    /**
     * Set the output level for an aux bus.
     * @param auxId The aux bus ID.
     * @param level The protocol level (0-1023).
     * @returns Promise that resolves when the command is sent.
     */
    setAuxOutputLevel(auxId: number, level: number): Promise<void>;
    /**
     * Get the output level for an aux bus.
     * @param auxId The aux bus ID.
     * @returns Promise resolving to the protocol level (0-1023).
     */
    getAuxOutputLevel(auxId: number): Promise<number>;
    /**
     * Set routing to a main bus.
     * @param mainId The main bus ID.
     * @param routes Array of booleans for each fader.
     * @returns Promise that resolves when the command is sent.
     */
    setRouteToMain(mainId: number, routes: boolean[]): Promise<void>;
    /**
     * Set the stereo image for a fader.
     * @param faderId The fader ID.
     * @param image The stereo image configuration.
     * @returns Promise that resolves when the command is sent.
     */
    setStereoImage(faderId: number, image: {
        leftToBoth: boolean;
        rightToBoth: boolean;
    }): Promise<void>;
    /**
     * Get the assignment for a fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the fader assignment.
     */
    getFaderAssignment(faderId: number): Promise<FaderAssignment>;
    /**
     * Get the stereo image for a fader.
     * @param faderId The fader ID.
     * @returns Promise resolving to the stereo image.
     */
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
    /**
     * Get the effective maximum fader count based on console info or manual override.
     * @returns The maximum number of faders to use for validation and array sizing.
     */
    private getEffectiveMaxFaderCount;
    /**
     * Get the effective maximum fader count for external use.
     * This is the same as the private method but accessible to consumers.
     * @returns The maximum number of faders to use for validation and array sizing.
     */
    getMaxFaderCount(): number;
    /**
     * Wait for console info to be available, with optional timeout.
     * This ensures that the dynamic fader count is based on actual console capabilities.
     * @param timeoutMs Optional timeout in milliseconds (default: 5000ms)
     * @returns Promise that resolves when console info is available or timeout is reached
     */
    waitForConsoleInfo(timeoutMs?: number): Promise<ConsoleInfo | null>;
    /**
     * Get the effective maximum fader count, ensuring console info is available first.
     * This method will wait for console info if it's not already available.
     * @param waitForConsoleInfo Whether to wait for console info if not available (default: false)
     * @param timeoutMs Timeout for waiting for console info (default: 5000ms)
     * @returns Promise resolving to the maximum number of faders
     */
    getMaxFaderCountAsync(waitForConsoleInfo?: boolean, timeoutMs?: number): Promise<number>;
    /**
     * Get the effective maximum main count based on console info.
     * @returns The maximum number of mains to use for validation and array sizing.
     */
    private getEffectiveMaxMainCount;
}
//# sourceMappingURL=client.d.ts.map