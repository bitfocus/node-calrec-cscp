"use strict";
// src/types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.NakError = exports.AudioWidth = exports.AudioType = exports.ConnectionState = void 0;
/**
 * Enum for the client's connection state.
 */
var ConnectionState;
(function (ConnectionState) {
    ConnectionState["DISCONNECTED"] = "disconnected";
    ConnectionState["CONNECTING"] = "connecting";
    ConnectionState["CONNECTED"] = "connected";
    ConnectionState["RECONNECTING"] = "reconnecting";
    ConnectionState["ERROR"] = "error";
})(ConnectionState || (exports.ConnectionState = ConnectionState = {}));
/**
 * Enum for audio path types as defined in section 7.11.
 */
var AudioType;
(function (AudioType) {
    AudioType[AudioType["NO_AUDIO"] = 0] = "NO_AUDIO";
    AudioType[AudioType["AUDIO_CHANNEL"] = 1] = "AUDIO_CHANNEL";
    AudioType[AudioType["AUDIO_GROUP"] = 2] = "AUDIO_GROUP";
    AudioType[AudioType["VCA_MASTER_WITHOUT_SLAVE"] = 3] = "VCA_MASTER_WITHOUT_SLAVE";
    AudioType[AudioType["VCA_MASTER_WITH_CHANNEL_SLAVE"] = 4] = "VCA_MASTER_WITH_CHANNEL_SLAVE";
    AudioType[AudioType["VCA_MASTER_WITH_GROUP_SLAVE"] = 5] = "VCA_MASTER_WITH_GROUP_SLAVE";
    AudioType[AudioType["MAIN"] = 6] = "MAIN";
    AudioType[AudioType["VCA_MASTER_WITH_MAIN_SLAVE"] = 7] = "VCA_MASTER_WITH_MAIN_SLAVE";
    AudioType[AudioType["TRACK"] = 8] = "TRACK";
    AudioType[AudioType["VCA_MASTER_WITH_TRACK_SLAVE"] = 9] = "VCA_MASTER_WITH_TRACK_SLAVE";
    AudioType[AudioType["AUX_OUTPUT"] = 10] = "AUX_OUTPUT";
    AudioType[AudioType["VCA_MASTER_WITH_AUX_OUTPUT_SLAVE"] = 11] = "VCA_MASTER_WITH_AUX_OUTPUT_SLAVE";
})(AudioType || (exports.AudioType = AudioType = {}));
/**
 * Enum for audio path widths as defined in section 7.11.
 */
var AudioWidth;
(function (AudioWidth) {
    AudioWidth[AudioWidth["NO_AUDIO"] = 0] = "NO_AUDIO";
    AudioWidth[AudioWidth["MONO"] = 1] = "MONO";
    AudioWidth[AudioWidth["STEREO"] = 2] = "STEREO";
    AudioWidth[AudioWidth["SURROUND_5_1"] = 6] = "SURROUND_5_1";
})(AudioWidth || (exports.AudioWidth = AudioWidth = {}));
/**
 * Defines NAK error codes from section 5.7.
 */
var NakError;
(function (NakError) {
    NakError[NakError["COMMAND_NOT_SUPPORTED"] = 1] = "COMMAND_NOT_SUPPORTED";
    NakError[NakError["TIMEOUT"] = 2] = "TIMEOUT";
    NakError[NakError["UNDEFINED_ERROR"] = 4] = "UNDEFINED_ERROR";
    NakError[NakError["INTERFACE_ERROR"] = 8] = "INTERFACE_ERROR";
    NakError[NakError["BYTE_COUNT_ERROR"] = 16] = "BYTE_COUNT_ERROR";
    NakError[NakError["CHECKSUM_ERROR"] = 32] = "CHECKSUM_ERROR";
    NakError[NakError["PROTOCOL_ERROR"] = 64] = "PROTOCOL_ERROR";
})(NakError || (exports.NakError = NakError = {}));
//# sourceMappingURL=types.js.map