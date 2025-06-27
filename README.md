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

## Installation

```bash
npm install @bitfocusas/calrec-cscp
```

## Quick Start

```typescript
import { CalrecClient } from '@bitfocusas/calrec-cscp';

// Create a client instance
const client = new CalrecClient({
  host: '192.168.1.100', // Your Calrec console IP
  port: 1337,            // Your configured TCP port
});

// Set up event listeners
client.on('ready', () => {
  console.log('Connected and ready!');
});

client.on('faderLevelChange', (faderId, level) => {
  console.log(`Fader ${faderId} level changed to ${level}`);
});

client.on('error', (error) => {
  console.error('Connection error:', error);
});

// Connect to the console
client.connect();
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
  // Get console information
  const consoleInfo = await client.getConsoleInfo();
  console.log('Console:', consoleInfo.deskLabel);
  console.log('Max faders:', consoleInfo.maxFaders);
  
  // Set fader level (0-1000 range)
  await client.setFaderLevel(1, 500);
  
  // Set fader level in dB
  await client.setFaderLevelDb(1, -10);
  
  // Mute/unmute a fader
  await client.setFaderCut(1, true);
  
  // Get fader label
  const label = await client.getFaderLabel(1);
  console.log('Fader 1 label:', label);
});
```

### Advanced Routing Control

```typescript
client.on('ready', async () => {
  // Set aux routing (route fader 1 to aux 1 and 2)
  await client.setAuxRouting(1, [true, true, false, false]);
  
  // Monitor aux routing changes
  client.on('auxRoutingChange', (auxId, routes) => {
    console.log(`Aux ${auxId} routing changed:`, routes);
  });
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

// Manual disconnect
client.disconnect();
```

## API Reference

### CalrecClient

The main client class for communicating with Calrec consoles.

#### Constructor

```typescript
new CalrecClient(options: CalrecClientOptions)
```

**Options:**
- `host: string` - Console IP address
- `port: number` - TCP port number
- `autoReconnect?: boolean` - Enable auto-reconnection (default: true)
- `reconnectInterval?: number` - Reconnection delay in ms (default: 5000)

#### Methods

##### Connection Management
- `connect()` - Connect to the console
- `disconnect()` - Disconnect from the console
- `getState()` - Get current client state
- `getConnectionState()` - Get connection state

##### Console Information
- `getConsoleInfo()` - Get console information
- `getConsoleName()` - Get console name

##### Fader Control
- `setFaderLevel(faderId: number, level: number)` - Set fader level (0-1000)
- `getFaderLevel(faderId: number)` - Get fader level
- `setFaderLevelDb(faderId: number, db: number)` - Set fader level in dB
- `getFaderLevelDb(faderId: number)` - Get fader level in dB
- `setFaderCut(faderId: number, isCut: boolean)` - Mute/unmute fader
- `getFaderLabel(faderId: number)` - Get fader label

##### Main Fader Control
- `setMainFaderLevelDb(mainId: number, db: number)` - Set main fader level in dB
- `getMainFaderLevelDb(mainId: number)` - Get main fader level in dB

##### Routing Control
- `setAuxRouting(auxId: number, routes: boolean[])` - Set aux routing

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

##### Other Events
- `unsolicitedMessage` - Raw unsolicited message received

### Types

The library exports comprehensive TypeScript types:

```typescript
import {
  ConnectionState,
  CalrecClientOptions,
  ConsoleInfo,
  FaderAssignment,
  AudioType,
  AudioWidth,
  StereoImage,
  NakError
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

### Network Requirements

- TCP/IP connectivity to the console
- Port access (typically 1337, but configurable)
- Stable network connection for reliable operation

## Error Handling

The library provides comprehensive error handling:

```typescript
client.on('error', (error) => {
  if (error instanceof NakError) {
    console.error('Protocol error:', error.message);
  } else {
    console.error('Connection error:', error);
  }
});
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