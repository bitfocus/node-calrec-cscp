// [protocol_value, dB_value]
type ConversionPoint = [number, number];

// Data from the "Protocol Level to dB conversion table" Appendix
const MAIN_FADER_MAP: ConversionPoint[] = [
	[0, -100],
	[40, -100],
	[80, -70],
	[162, -50],
	[519, -20],
	[760, -10],
	[1004, 0],
	[1023, 0],
];

const CHANNEL_FADER_MAP: ConversionPoint[] = [
	[0, -100],
	[40, -100],
	[80, -60],
	[162, -40],
	[519, -20],
	[760, 0],
	[1004, 10],
	[1023, 10],
];

/**
 * Generic function to perform linear interpolation between points in a map.
 * @param value The value to convert (either level or dB).
 * @param map The conversion map to use.
 * @param fromIndex The index of the value in the ConversionPoint tuple (0 for level, 1 for dB).
 * @param toIndex The index of the target value in the ConversionPoint tuple (1 for dB, 0 for level).
 * @returns The converted value.
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
	// For level conversion, round to the nearest integer
	return toIndex === 0 ? Math.round(result) : result;
}

/**
 * Converts a Main Fader protocol level (0-1023) to decibels (dB).
 * @param level The protocol level.
 * @returns The dB value.
 */
export function mainLevelToDb(level: number): number {
	return interpolate(level, MAIN_FADER_MAP, 0, 1);
}

/**
 * Converts decibels (dB) to the nearest Main Fader protocol level (0-1023).
 * @param db The dB value.
 * @returns The protocol level.
 */
export function dbToMainLevel(db: number): number {
	return interpolate(db, MAIN_FADER_MAP, 1, 0);
}

/**
 * Converts a Channel/Group/VCA Fader protocol level (0-1023) to decibels (dB).
 * @param level The protocol level.
 * @returns The dB value.
 */
export function channelLevelToDb(level: number): number {
	return interpolate(level, CHANNEL_FADER_MAP, 0, 1);
}

/**
 * Converts decibels (dB) to the nearest Channel/Group/VCA Fader protocol level (0-1023).
 * @param db The dB value.
 * @returns The protocol level.
 */
export function dbToChannelLevel(db: number): number {
	return interpolate(db, CHANNEL_FADER_MAP, 1, 0);
}
