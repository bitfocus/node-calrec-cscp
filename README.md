# Calrec CSCP Protocol Client

[![npm version](https://badge.fury.io/js/@bitfocusas%2Fcalrec-cscp.svg)](https://badge.fury.io/js/@bitfocusas%2Fcalrec-cscp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Node.js client library for communicating with Calrec audio consoles using the CSCP (Calrec Serial Control Protocol). This library provides a robust, type-safe interface for controlling and monitoring Calrec mixing consoles over TCP/IP.

## Features

- 🔌 **TCP/IP Communication** - Connect to Calrec consoles over network
- 🎛️ **Full Console Control** - Control faders, mutes, routing, and more
- 📡 **Real-time Monitoring** - Receive live updates from the console
- 🔄 **Auto-reconnection** - Automatic reconnection on connection loss
- 🛡️ **Type Safety** - Full TypeScript support with comprehensive type definitions
- 🎯 **Event-driven** - Clean event-based API for state changes
- 📊 **Unit Conversion** - Built-in dB/level conversion utilities
- ⚙️ **Configurable Timing** - Runtime-configurable protocol timing settings
- 🚀 **Async/Await** - Modern async API with robust error handling

## Installation

```bash
npm install @bitfocusas/calrec-cscp
```

## Quick Start

```typescript
import { CalrecClient } from '@bitfocusas/calrec-cscp';

// Create a client instance with custom settings
const client = new CalrecClient(
  {
    host: '192.168.1.100', // Your Calrec console IP
    port: 1337,            // Your configured TCP port
    autoReconnect: true,
    reconnectInterval: 5000,
  },
  {
    // Optional: Custom protocol timing settings
    globalCommandRateMs: 10,      // Minimum ms between any command
    faderLevelRateMs: 100,        // Minimum ms between fader level commands
    commandResponseTimeoutMs: 20,  // Timeout for command responses
  }
);

// Set up event listeners
client.on('ready', async () => {
  console.log('Connected and ready!');
  
  // Example: Update settings at runtime
  client.updateSettings({
    faderLevelRateMs: 50, // Faster fader updates
  });
});

client.on('faderLevelChange', (faderId, level) => {
  console.log(`Fader ${faderId} level changed to ${level}`);
});

client.on('error', (error) => {
  console.error('Connection error:', error);
});

// Connect to the console (now async)
await client.connect();
```

## Usage Examples

### Basic Console Control

```typescript
import { CalrecClient } from '@bitfocusas/calrec-cscp';

const client = new CalrecClient({
  host: '192.168.1.100',
  port: 1337,
});

client.on('ready', async () => {
  try {
    // Get console information
    const consoleInfo = await client.getConsoleInfo();
    console.log('Console:', consoleInfo.deskLabel);
    console.log('Max faders:', consoleInfo.maxFaders);
    
    // Set fader level (0-1023 range)
    await client.setFaderLevel(1, 500);
    
    // Set fader level in dB
    await client.setFaderLevelDb(1, -10);
    
    // Mute/unmute a fader
    await client.setFaderCut(1, true);
    
    // Get fader label
    const label = await client.getFaderLabel(1);
    console.log('Fader 1 label:', label);
  } catch (error) {
    console.error('Operation failed:', error);
  }
});

// Connect to the console
await client.connect();
```

### Advanced Routing Control

```typescript
client.on('ready', async () => {
  try {
    // Set aux routing (route fader 1 to aux 1 and 2)
    await client.setAuxRouting(1, [true, true, false, false]);
    
    // Set stereo image for a fader
    await client.setStereoImage(1, { leftToBoth: true, rightToBoth: false });
    
    // Get fader assignment
    const assignment = await client.getFaderAssignment(1);
    console.log('Fader 1 assignment:', assignment);
  } catch (error) {
    console.error('Routing operation failed:', error);
  }
});

// Monitor aux routing changes
client.on('auxRoutingChange', (auxId, routes) => {
  console.log(`Aux ${auxId} routing changed:`, routes);
});
```

### Real-time Monitoring

```typescript
// Monitor all fader changes
client.on('faderLevelChange', (faderId, level) => {
  console.log(`Fader ${faderId}: ${level}`);
});

client.on('faderCutChange', (faderId, isCut) => {
  console.log(`Fader ${faderId} ${isCut ? 'muted' : 'unmuted'}`);
});

client.on('faderLabelChange', (faderId, label) => {
  console.log(`Fader ${faderId} label: ${label}`);
});

client.on('faderAssignmentChange', (assignment) => {
  console.log('Fader assignment changed:', assignment);
});

client.on('stereoImageChange', (faderId, image) => {
  console.log(`Fader ${faderId} stereo image:`, image);
});
```

### Connection Management

```typescript
// Monitor connection state
client.on('connectionStateChange', (state) => {
  console.log('Connection state:', state);
});

client.on('connect', () => {
  console.log('Connected to console');
});

client.on('disconnect', () => {
  console.log('Disconnected from console');
});

// Manual disconnect (now async)
await client.disconnect();
```

### Error Handling

```typescript
// Comprehensive error handling
client.on('error', (error) => {
  console.error('Client error:', error.message);
});

// Handle errors in async operations
try {
  await client.setFaderLevel(1, 500);
} catch (error) {
  if (error.message.includes('NAK')) {
    console.error('Protocol error - command rejected by console');
  } else if (error.message.includes('timeout')) {
    console.error('Command timed out');
  } else if (error.message.includes('not connected')) {
    console.error('Client is not connected');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## API Reference

### CalrecClient

The main client class for communicating with Calrec consoles.

#### Constructor

```typescript
new CalrecClient(options: CalrecClientOptions, settings?: CalrecClientSettings)
```

**Options:**
- `host: string` - Console IP address
- `port: number` - TCP port number
- `autoReconnect?: boolean` - Enable auto-reconnection (default: true)
- `reconnectInterval?: number` - Reconnection delay in ms (default: 5000)
- `maxFaderCount?: number` - Maximum number of faders (for validation)

**Settings:**
- `globalCommandRateMs?: number` - Minimum ms between any command (default: 10)
- `faderLevelRateMs?: number` - Minimum ms between fader level commands (default: 100)
- `commandResponseTimeoutMs?: number` - Timeout for command responses (default: 20)

#### Methods

##### Connection Management
- `connect(): Promise<void>` - Connect to the console
- `disconnect(): Promise<void>` - Disconnect from the console
- `getState(): ClientState` - Get current client state
- `getConnectionState(): ConnectionState` - Get connection state
- `updateSettings(settings: CalrecClientSettings): void` - Update protocol settings at runtime

##### Console Information
- `getConsoleInfo(): Promise<ConsoleInfo>` - Get console information
- `getConsoleName(): Promise<string>` - Get console name

##### Fader Control
- `setFaderLevel(faderId: number, level: number): Promise<void>` - Set fader level (0-1023)
- `getFaderLevel(faderId: number): Promise<number>` - Get fader level
- `setFaderLevelDb(faderId: number, db: number): Promise<void>` - Set fader level in dB
- `getFaderLevelDb(faderId: number): Promise<number>` - Get fader level in dB
- `setFaderCut(faderId: number, isCut: boolean): Promise<void>` - Mute/unmute fader
- `getFaderCut(faderId: number): Promise<boolean>` - Get fader cut state
- `getFaderLabel(faderId: number): Promise<string>` - Get fader label
- `setFaderPfl(faderId: number, isPfl: boolean): Promise<void>` - Set fader PFL state
- `getFaderPfl(faderId: number): Promise<boolean>` - Get fader PFL state
- `getFaderAssignment(faderId: number): Promise<FaderAssignment>` - Get fader assignment

##### Main Fader Control
- `setMainFaderLevelDb(mainId: number, db: number): Promise<void>` - Set main fader level in dB
- `getMainFaderLevelDb(mainId: number): Promise<number>` - Get main fader level in dB
- `setMainFaderPfl(mainId: number, isPfl: boolean): Promise<void>` - Set main fader PFL state
- `getMainPfl(mainId: number): Promise<boolean>` - Get main fader PFL state
- `getMainFaderLabel(mainId: number): Promise<string>` - Get main fader label

##### Routing Control (V20+)
- `getAvailableAux(): Promise<boolean[]>` - Get available auxiliary outputs
- `setAuxRouting(auxId: number, routes: boolean[]): Promise<void>` - Set aux routing
- `getAuxSendRouting(auxId: number): Promise<boolean[]>` - Get aux routing
- `setAuxOutputLevel(auxId: number, level: number): Promise<void>` - Set aux output level
- `getAuxOutputLevel(auxId: number): Promise<number>` - Get aux output level

##### Main Routing Control (V21+)
- `getAvailableMains(): Promise<boolean[]>` - Get available main outputs
- `setRouteToMain(mainId: number, routes: boolean[]): Promise<void>` - Set main routing
- `getRouteToMain(mainId: number): Promise<boolean[]>` - Get main routing

##### Stereo Image Control (V21+)
- `setStereoImage(faderId: number, image: StereoImage): Promise<void>` - Set stereo image
- `getStereoImage(faderId: number): Promise<StereoImage>` - Get stereo image

#### Events

The client extends EventEmitter and provides the following events:

##### Connection Events
- `connect` - Connected to console
- `disconnect` - Disconnected from console
- `ready` - Client fully initialized and ready
- `error` - Connection or protocol error
- `connectionStateChange` - Connection state changed

##### Fader Events
- `faderLevelChange` - Fader level changed
- `faderCutChange` - Fader mute state changed
- `faderPflChange` - Fader PFL state changed
- `faderLabelChange` - Fader label changed
- `faderAssignmentChange` - Fader assignment changed

##### Main Fader Events
- `mainLevelChange` - Main fader level changed
- `mainPflChange` - Main fader PFL state changed
- `mainLabelChange` - Main fader label changed

##### Aux Events
- `availableAuxesChange` - Available auxes changed
- `auxRoutingChange` - Aux routing changed
- `auxOutputLevelChange` - Aux output level changed

##### Main Routing Events
- `availableMainsChange` - Available mains changed
- `mainRoutingChange` - Main routing changed

##### Stereo Image Events
- `stereoImageChange` - Stereo image settings changed

##### Other Events
- `unsolicitedMessage` - Raw unsolicited message received (only for truly unknown commands)

### Examples

The library includes a comprehensive examples script that demonstrates all available functionality organized by protocol levels:

```bash
# Show help
npm run examples -- --help

# Run all examples (default)
npm run examples

# Run only basic commands (V1)
npm run examples -- --level v1

# Run V1 + V20 commands
npm run examples -- --level v20

# Run V1 + V20 + V21 commands
npm run examples -- --level v21

# Use custom console settings
npm run examples -- --host 192.168.1.100 --port 1338
```

The examples are organized by protocol levels:
- **V1**: Basic commands (all consoles)
- **V20**: V1 + Auxiliary send routing extensions
- **V21**: V20 + Channel/Group routing to mains extensions

**Note:** The examples script includes comprehensive event handling for all unsolicited messages from the console, providing real-time feedback on state changes while minimizing debug noise.

### Types

The library exports comprehensive TypeScript types:

```typescript
import {
  ConnectionState,
  CalrecClientOptions,
  CalrecClientSettings,
  ConsoleInfo,
  FaderAssignment,
  AudioType,
  AudioWidth,
  StereoImage,
  NakError,
  ClientState,
  ParsedMessage,
  CalrecClientEvents
} from '@bitfocusas/calrec-cscp';
```

### Converters

Utility functions for converting between different units:

```typescript
import {
  dbToChannelLevel,
  dbToMainLevel,
  channelLevelToDb,
  mainLevelToDb
} from '@bitfocusas/calrec-cscp';
```

## Configuration

### Console Setup

1. Configure your Calrec console to enable CSCP over TCP/IP
2. Set the appropriate IP address and port
3. Ensure network connectivity between your application and the console

### Protocol Timing Settings

The library allows you to configure protocol timing for optimal performance:

```typescript
const client = new CalrecClient(
  { host: '192.168.1.100', port: 1337 },
  {
    globalCommandRateMs: 10,      // Minimum ms between any command
    faderLevelRateMs: 100,        // Minimum ms between fader level commands
    commandResponseTimeoutMs: 20,  // Timeout for command responses
  }
);

// Update settings at runtime
client.updateSettings({
  faderLevelRateMs: 50, // Faster fader updates
});
```

### Network Requirements

- TCP/IP connectivity to the console
- Port access (typically 1337, but configurable)
- Stable network connection for reliable operation

## Error Handling

The library provides comprehensive error handling with detailed error messages:

```typescript
client.on('error', (error) => {
  console.error('Client error:', error.message);
});

// Handle specific error types
try {
  await client.setFaderLevel(1, 500);
} catch (error) {
  if (error.message.includes('NAK')) {
    console.error('Protocol error - command rejected by console');
  } else if (error.message.includes('timeout')) {
    console.error('Command timed out');
  } else if (error.message.includes('not connected')) {
    console.error('Client is not connected');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Development

### Building from Source

```bash
git clone https://github.com/bitfocusas/calrec-cscp.git
cd calrec-cscp
npm install
npm run build
```

### Running Examples

```bash
npm run dev
```

### Code Quality

```bash
npm run lint    # Lint code
npm run format  # Format code
npm run check   # Run all checks
```

## Contributing

We welcome contributions! This library is provided free of charge by Bitfocus AS to the audio community.

### How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests if applicable
5. Run the linter and formatter (`npm run check`)
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

### Development Guidelines

- Follow the existing code style (enforced by Biome)
- Add TypeScript types for all new features
- Include JSDoc comments for public APIs
- Test your changes thoroughly
- Update documentation as needed

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/bitfocusas/calrec-cscp/issues)
- **Documentation**: [GitHub Wiki](https://github.com/bitfocusas/calrec-cscp/wiki)
- **Email**: william@bitfocus.io

## Acknowledgments

- Calrec Audio for the CSCP protocol specification
- The audio engineering community for feedback and testing
- All contributors who help improve this library

---

**Made with ❤️ by Bitfocus AS** 