"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainLevelToDb = mainLevelToDb;
exports.dbToMainLevel = dbToMainLevel;
exports.channelLevelToDb = channelLevelToDb;
exports.dbToChannelLevel = dbToChannelLevel;
// Data from the "Protocol Level to dB conversion table" Appendix
const MAIN_FADER_MAP = [
    [0, -100],
    [40, -100],
    [80, -70],
    [162, -50],
    [519, -20],
    [760, -10],
    [1004, 0],
    [1023, 0],
];
// TODO: Fix this.. It should adhere to the complete list of points in the spec. For now: good enough.
const CHANNEL_FADER_MAP = [
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
    [760, 0], // End of -10 to 0dB range
    [761, 0], // Start of linear steps from 0 to 10dB
    [1004, 10], // End of 0 to 10dB range
    [1023, 10], // 1004-1023 = 10dB
];
/**
 * Generic function to perform linear interpolation between points in a map.
 * @param value The value to convert (either level or dB).
 * @param map The conversion map to use.
 * @param fromIndex The index of the value in the ConversionPoint tuple (0 for level, 1 for dB).
 * @param toIndex The index of the target value in the ConversionPoint tuple (1 for dB, 0 for level).
 * @returns The converted value.
 */
function interpolate(value, map, fromIndex, toIndex) {
    // Find the two points the value lies between
    let p1 = map[0];
    let p2 = map[map.length - 1];
    for (let i = 0; i < map.length - 1; i++) {
        if (value >= map[i][fromIndex] && value <= map[i + 1][fromIndex]) {
            p1 = map[i];
            p2 = map[i + 1];
            break;
        }
    }
    // Handle edge cases where value is outside the map range
    if (value < p1[fromIndex])
        return p1[toIndex];
    if (value > p2[fromIndex])
        return p2[toIndex];
    const fromRange = p2[fromIndex] - p1[fromIndex];
    // Avoid division by zero if points are identical
    if (fromRange === 0)
        return p1[toIndex];
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
function mainLevelToDb(level) {
    return interpolate(level, MAIN_FADER_MAP, 0, 1);
}
/**
 * Converts decibels (dB) to the nearest Main Fader protocol level (0-1023).
 * @param db The dB value.
 * @returns The protocol level.
 */
function dbToMainLevel(db) {
    return interpolate(db, MAIN_FADER_MAP, 1, 0);
}
/**
 * Converts a Channel/Group/VCA Fader protocol level (0-1023) to decibels (dB).
 * @param level The protocol level.
 * @returns The dB value.
 */
function channelLevelToDb(level) {
    return interpolate(level, CHANNEL_FADER_MAP, 0, 1);
}
/**
 * Converts decibels (dB) to the nearest Channel/Group/VCA Fader protocol level (0-1023).
 * @param db The dB value.
 * @returns The protocol level.
 */
function dbToChannelLevel(db) {
    return interpolate(db, CHANNEL_FADER_MAP, 1, 0);
}
//# sourceMappingURL=converters.js.map