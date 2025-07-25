"use strict";
// src/types.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.NakError = exports.AudioWidth = exports.AudioType = exports.ConnectionState = void 0;
/**
 * Enum for the client's connection state.
 */
var ConnectionState;
(function (ConnectionState) {
    /** Client is not connected to the console */
    ConnectionState["DISCONNECTED"] = "disconnected";
    /** Client is attempting to connect */
    ConnectionState["CONNECTING"] = "connecting";
    /** Client is connected and ready */
    ConnectionState["CONNECTED"] = "connected";
    /** Client is attempting to reconnect after a disconnect */
    ConnectionState["RECONNECTING"] = "reconnecting";
    /** Client encountered an error */
    ConnectionState["ERROR"] = "error";
})(ConnectionState || (exports.ConnectionState = ConnectionState = {}));
/**
 * Enum for audio path types as defined in section 7.11 of the protocol specification.
 */
var AudioType;
(function (AudioType) {
    /** No audio assigned */
    AudioType[AudioType["NO_AUDIO"] = 0] = "NO_AUDIO";
    /** Audio channel */
    AudioType[AudioType["AUDIO_CHANNEL"] = 1] = "AUDIO_CHANNEL";
    /** Audio group */
    AudioType[AudioType["AUDIO_GROUP"] = 2] = "AUDIO_GROUP";
    /** VCA master without slave */
    AudioType[AudioType["VCA_MASTER_WITHOUT_SLAVE"] = 3] = "VCA_MASTER_WITHOUT_SLAVE";
    /** VCA master with channel slave */
    AudioType[AudioType["VCA_MASTER_WITH_CHANNEL_SLAVE"] = 4] = "VCA_MASTER_WITH_CHANNEL_SLAVE";
    /** VCA master with group slave */
    AudioType[AudioType["VCA_MASTER_WITH_GROUP_SLAVE"] = 5] = "VCA_MASTER_WITH_GROUP_SLAVE";
    /** Main output */
    AudioType[AudioType["MAIN"] = 6] = "MAIN";
    /** VCA master with main slave */
    AudioType[AudioType["VCA_MASTER_WITH_MAIN_SLAVE"] = 7] = "VCA_MASTER_WITH_MAIN_SLAVE";
    /** Track output */
    AudioType[AudioType["TRACK"] = 8] = "TRACK";
    /** VCA master with track slave */
    AudioType[AudioType["VCA_MASTER_WITH_TRACK_SLAVE"] = 9] = "VCA_MASTER_WITH_TRACK_SLAVE";
    /** Aux output */
    AudioType[AudioType["AUX_OUTPUT"] = 10] = "AUX_OUTPUT";
    /** VCA master with aux output slave */
    AudioType[AudioType["VCA_MASTER_WITH_AUX_OUTPUT_SLAVE"] = 11] = "VCA_MASTER_WITH_AUX_OUTPUT_SLAVE";
})(AudioType || (exports.AudioType = AudioType = {}));
/**
 * Enum for audio path widths as defined in section 7.11 of the protocol specification.
 */
var AudioWidth;
(function (AudioWidth) {
    /** No audio */
    AudioWidth[AudioWidth["NO_AUDIO"] = 0] = "NO_AUDIO";
    /** Mono audio */
    AudioWidth[AudioWidth["MONO"] = 1] = "MONO";
    /** Stereo audio */
    AudioWidth[AudioWidth["STEREO"] = 2] = "STEREO";
    /** 5.1 surround audio */
    AudioWidth[AudioWidth["SURROUND_5_1"] = 6] = "SURROUND_5_1";
})(AudioWidth || (exports.AudioWidth = AudioWidth = {}));
/**
 * Defines NAK error codes from section 5.7 of the protocol specification.
 */
var NakError;
(function (NakError) {
    /** Command is not supported by the console */
    NakError[NakError["COMMAND_NOT_SUPPORTED"] = 1] = "COMMAND_NOT_SUPPORTED";
    /** Command timed out */
    NakError[NakError["TIMEOUT"] = 2] = "TIMEOUT";
    /** Undefined error occurred */
    NakError[NakError["UNDEFINED_ERROR"] = 4] = "UNDEFINED_ERROR";
    /** Interface error occurred */
    NakError[NakError["INTERFACE_ERROR"] = 8] = "INTERFACE_ERROR";
    /** Byte count error in the message */
    NakError[NakError["BYTE_COUNT_ERROR"] = 16] = "BYTE_COUNT_ERROR";
    /** Checksum error in the message */
    NakError[NakError["CHECKSUM_ERROR"] = 32] = "CHECKSUM_ERROR";
    /** Protocol error occurred */
    NakError[NakError["PROTOCOL_ERROR"] = 64] = "PROTOCOL_ERROR";
})(NakError || (exports.NakError = NakError = {}));
//# sourceMappingURL=types.js.map