# Eaglercraft 26.2 

This ZIP lets you run Eaglercraft 26.2 locally. 
The first launch will download the required server files.

## Requirements

Before starting, make sure you have:

- **Node.js 20 or newer** (with npm)
- **Java 25 JDK**
- An strong internet connection for the first setup
- Around 3 GB of available RAM for the server

Downloads:
- [Node.js](https://nodejs.org/)
- [Eclipse Temurin JDK 25](https://adoptium.net/temurin/releases/?version=25)

## macOS Setup

1. Extract the ZIP file somewhere on your Mac.
2. Install Node.js and Java 25 if you haven't already.
3. Double-click `START-MACOS.command` to launch the setup.
4. If macOS blocks the script, control-click it and select **Open**.
5. Read and accept the Minecraft EULA when prompted in Terminal.

The launcher will download Paper, Velocity, EaglerXServer, ViaVersion, and ViaBackwards automatically.

You can also start it manually through Terminal:

```sh
npm install
npm start
```

## Windows Setup

1. Extract the ZIP file into a folder.
2. Make sure Node.js 20+ and Java 25 are installed.
3. Double-click `START-WINDOWS.bat`.
4. Follow the instructions in Command Prompt and accept the EULA if you agree to it.

The launcher will handle the rest.

## Connecting to the Server

Once everything starts, open your browser and visit:

**Game client:** http://localhost:3001

**Multiplayer server:** `ws://localhost:25557/`

**Paper backend:** `127.0.0.1:25566`

The local multiplayer server should already be added to your server list.

Keep the Terminal or Command Prompt window open while playing. Closing it will stop the server.

If you want friends to connect over the internet, you'll need to host the web client and WebSocket endpoint publicly. Update `publicWebSocketUrl` in `config.json` with your public `wss://` address.

## Configuration

Most server settings can be changed in `config.json`, including:

- Server name
- Game mode
- Maximum players
- Server ports

Survival mode is enabled by default.

## Stopping the Server

To shut everything down, press `Ctrl+C` in the launcher window.

If something isn't working, run:

```sh
npm run doctor
```

This checks your local setup for common problems.

The server files are downloaded into the `runtime/` folder during the first setup. They aren't included in the ZIP.

The Eaglercraft client and world files are already included, so you won't need to download those separately.
