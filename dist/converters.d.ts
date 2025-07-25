/**
 * Converts a Main Fader protocol level (0-1023) to decibels (dB).
 *
 * @param level - The protocol level (0-1023)
 * @returns The dB value (typically -100 to 0 dB)
 */
export declare function mainLevelToDb(level: number): number;
/**
 * Converts decibels (dB) to the nearest Main Fader protocol level (0-1023).
 *
 * @param db - The dB value (typically -100 to 0 dB)
 * @returns The protocol level (0-1023)
 */
export declare function dbToMainLevel(db: number): number;
/**
 * Converts a Channel/Group/VCA Fader protocol level (0-1023) to decibels (dB).
 *
 * @param level - The protocol level (0-1023)
 * @returns The dB value (typically -100 to +10 dB)
 */
export declare function channelLevelToDb(level: number): number;
/**
 * Converts decibels (dB) to the nearest Channel/Group/VCA Fader protocol level (0-1023).
 *
 * @param db - The dB value (typically -100 to +10 dB)
 * @returns The protocol level (0-1023)
 */
export declare function dbToChannelLevel(db: number): number;
//# sourceMappingURL=converters.d.ts.map