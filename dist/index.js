"use strict";
/** biome-ignore-all assist/source/organizeImports: stupid */
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalrecClient = void 0;
// src/index.ts
// Main client class
var client_1 = require("./client");
Object.defineProperty(exports, "CalrecClient", { enumerable: true, get: function () { return client_1.CalrecClient; } });
// All types and interfaces
__exportStar(require("./types"), exports);
// Conversion utilities
__exportStar(require("./converters"), exports);
//# sourceMappingURL=index.js.map