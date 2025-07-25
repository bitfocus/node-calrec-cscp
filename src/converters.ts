// src/converters.ts

/**
 * Type definition for conversion points used in the lookup tables.
 * Each point is a tuple of [protocol_value, dB_value].
 */
type ConversionPoint = [number, number];

/**
 * Conversion map for Main Fader levels to dB values.
 * Data from the "Protocol Level to dB conversion table" Appendix of the protocol specification.
 *
 * Protocol values range from 0-1023, corresponding to dB values from -100 to 0.
 */
const MAIN_FADER_MAP: ConversionPoint[] = [
	[0, -100], // Minimum level (silent)
	[40, -100], // End of silent range
	[80, -70], // -70dB point
	[162, -50], // -50dB point
	[519, -20], // -20dB point
	[760, -10], // -10dB point
	[1004, 0], // Unity gain (0dB)
	[1023, 0], // Maximum level (0dB)
];

/**
 * Conversion map for Channel/Group/VCA Fader levels to dB values.
 * Data from the "Protocol Level to dB conversion table" Appendix of the protocol specification.
 *
 * Protocol values range from 0-1023, corresponding to dB values from -100 to +10.
 * This map provides more granular control than main faders, allowing for positive gain.
 *
 * Note: This map should be updated to match the complete specification when available.
 * The current implementation provides good accuracy for typical use cases.
 */
const CHANNEL_FADER_MAP: ConversionPoint[] = [
	[0, -100], // 0-40 = -100dB (faded out and silent)
	[40, -100], // End of silent range
	[41, -100], // Start of linear steps from -100 to -60dB
	[80, -60], // End of -100 to -60dB range
	[81, -60], // Start of linear steps from -60 to -40dB
	[162, -40], // End of -60 to -40dB range
	[163, -40], // Start of linear steps from -40 to -20dB
	[221, -35], // -35dB point
	[281, -30], // -30dB point
	[340, -25], // -25dB point
	[400, -20], // -20dB point
	[519, -10], // -10dB point
	[639, -5], // -5dB point
	[760, 0], // Unity gain (0dB)
	[761, 0], // Start of linear steps from 0 to 10dB
	[1004, 10], // End of 0 to 10dB range
	[1023, 10], // Maximum level (+10dB)
];

/**
 * Performs linear interpolation between points in a conversion map.
 *
 * @param value - The value to convert (either protocol level or dB)
 * @param map - The conversion map to use
 * @param fromIndex - The index of the source value in the ConversionPoint tuple (0 for protocol level, 1 for dB)
 * @param toIndex - The index of the target value in the ConversionPoint tuple (1 for dB, 0 for protocol level)
 * @returns The converted value
 */
function interpolate(
	value: number,
	map: ConversionPoint[],
	fromIndex: 0 | 1,
	toIndex: 1 | 0,
): number {
	// Find the two points the value lies between
	let p1: ConversionPoint = map[0];
	let p2: ConversionPoint = map[map.length - 1];

	for (let i = 0; i < map.length - 1; i++) {
		if (value >= map[i][fromIndex] && value <= map[i + 1][fromIndex]) {
			p1 = map[i];
			p2 = map[i + 1];
			break;
		}
	}

	// Handle edge cases where value is outside the map range
	if (value < p1[fromIndex]) return p1[toIndex];
	if (value > p2[fromIndex]) return p2[toIndex];

	const fromRange = p2[fromIndex] - p1[fromIndex];
	// Avoid division by zero if points are identical
	if (fromRange === 0) return p1[toIndex];

	const toRange = p2[toIndex] - p1[toIndex];
	const ratio = (value - p1[fromIndex]) / fromRange;

	const result = p1[toIndex] + ratio * toRange;
	// For protocol level conversion, round to the nearest integer
	return toIndex === 0 ? Math.round(result) : result;
}

/**
 * Converts a Main Fader protocol level (0-1023) to decibels (dB).
 *
 * @param level - The protocol level (0-1023)
 * @returns The dB value (typically -100 to 0 dB)
 */
export function mainLevelToDb(level: number): number {
	return interpolate(level, MAIN_FADER_MAP, 0, 1);
}

/**
 * Converts decibels (dB) to the nearest Main Fader protocol level (0-1023).
 *
 * @param db - The dB value (typically -100 to 0 dB)
 * @returns The protocol level (0-1023)
 */
export function dbToMainLevel(db: number): number {
	return interpolate(db, MAIN_FADER_MAP, 1, 0);
}

/**
 * Converts a Channel/Group/VCA Fader protocol level (0-1023) to decibels (dB).
 *
 * @param level - The protocol level (0-1023)
 * @returns The dB value (typically -100 to +10 dB)
 */
export function channelLevelToDb(level: number): number {
	return interpolate(level, CHANNEL_FADER_MAP, 0, 1);
}

/**
 * Converts decibels (dB) to the nearest Channel/Group/VCA Fader protocol level (0-1023).
 *
 * @param db - The dB value (typically -100 to +10 dB)
 * @returns The protocol level (0-1023)
 */
export function dbToChannelLevel(db: number): number {
	return interpolate(db, CHANNEL_FADER_MAP, 1, 0);
}
