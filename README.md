# Sven Status Board

A LAN-only real-time status board for teams who cannot communicate by voice. Open the app in a browser, enter your name, and see a shared board of configurable status buttons. Pressing a button broadcasts a glowing alert to every connected client.

## Features

- Real-time sync across all connected clients via WebSockets
- Configurable button groups with per-group colors and auto-reset timers
- Screen glow effect on button press
- Scrollable history log of recent actions
- No persistence — state resets on server restart

## Quick Start

```bash
npm install
npm start
```

Open `http://<server-ip>:3000` in any browser on the LAN.

## Configuration

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
