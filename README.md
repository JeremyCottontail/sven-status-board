# Sven Status Board

A LAN-only real-time status board for teams who cannot communicate by voice. Open the app in a browser, enter your name, and see a shared board of configurable status buttons. Pressing a button broadcasts a glowing alert to every connected client.

## Features

- Real-time sync across all connected clients via WebSockets
- Configurable button groups with per-group colors and auto-reset timers
- Screen glow effect on button press
- Scrollable history log of recent actions
- No persistence — state resets on server restart

## Quick Start

### macOS / Linux

```bash
npm install
npm start
```

Open `http://<server-ip>:3000` in any browser on the LAN.

### Windows

1. **Install Node.js** — download and run the LTS installer from [nodejs.org](https://nodejs.org). Accept all defaults.

2. **Open Command Prompt or PowerShell** in the project folder.  
   (Shift-right-click the folder in Explorer → "Open in Terminal", or `cd` to it.)

3. **Install dependencies and start the server:**

   ```bat
   npm install
   npm start
   ```

4. **Allow Node.js through the firewall** — Windows will show a security prompt the first time. Click "Allow access" so other devices on the LAN can reach the server.

5. **Find your local IP** — open a second terminal and run:

   ```bat
   ipconfig
   ```

   Look for the `IPv4 Address` under your active adapter (usually starts with `192.168.` or `10.`). The app also shows the IP:port in the top-right chip once it starts.

6. Open `http://<your-ip>:3000` in any browser on the LAN.

To stop the server, press `Ctrl+C` in the terminal.

## Configuration

### Network / port

By default the server picks the first non-internal IPv4 address it finds, which can be the wrong one if both Wi-Fi and Ethernet are connected at the same time. To control this, copy `.env.example` to `.env` and set one of:

```bash
# Pin the adapter by name (macOS: `ifconfig`, e.g. en0 = Wi-Fi; Windows: `ipconfig`, e.g. "Wi-Fi")
NETWORK_INTERFACE=en0

# Or hardcode the IP shown in the UI / QR code directly (takes priority over NETWORK_INTERFACE)
HOST=192.168.1.50

# Optionally override the port
PORT=3000
```

`.env` is gitignored and read automatically on startup — no extra dependency or flags needed.

### Buttons

Edit `config.json` to customize button groups. Changes require a server restart.

```json
{
  "screenGlow": true,
  "groups": [
    {
      "name": "Drinks",
      "glowDuration": 30,
      "color": "#4ade80",
      "buttons": [
        { "id": "water-gas", "label": "Water with gas" }
      ]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `screenGlow` | Flash the full screen on every button press |
| `groups[].glowDuration` | Seconds before auto-reset; `0` = manual cancel only |
| `groups[].color` | Hex color for button glow and screen flash |
| `groups[].buttons[].id` | Unique identifier (must be unique across all groups) |

## Stack

- **Server:** Node.js, Express, `ws`
- **Frontend:** Vanilla HTML/CSS/JS — no build step
