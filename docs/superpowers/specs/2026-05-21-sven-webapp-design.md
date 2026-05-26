# Sven Webapp — Design Spec

**Date:** 2026-05-21  
**Status:** Approved

---

## Overview

A LAN-only real-time status board for teams who cannot communicate by voice. Anyone on the network opens the app in a browser, enters their name, and sees a shared board of configurable status buttons. Pressing a button broadcasts a glowing alert to every connected client. No data is persisted — all state lives in server memory and resets on restart.

---

## Tech Stack

- **Runtime:** Node.js
- **Server:** Express (static file serving) + `ws` (WebSocket server) on a single port
- **Frontend:** Vanilla HTML/CSS/JS — no build step, no framework
- **Config:** `config.json` read once at server startup

---

## File Structure

```
sven-webapp/
├── server.js          # Express + WebSocket server
├── config.json        # Button groups, glow settings
├── package.json
└── public/
    ├── index.html     # Single page: join screen + main app
    ├── style.css      # Dark theme, glow animations
    └── app.js         # Client WebSocket logic + UI rendering
```

---

## Configuration — `config.json`

```json
{
  "screenGlow": true,
  "groups": [
    {
      "name": "Drinks",
      "glowDuration": 30,
      "color": "#4ade80",
      "buttons": [
        { "id": "water-gas",   "label": "Water with gas" },
        { "id": "water-nogas", "label": "Water without gas" },
        { "id": "coke",        "label": "Coke" },
        { "id": "coke-zero",   "label": "Coke Zero" },
        { "id": "shorle",      "label": "Shorle" },
        { "id": "sprite",      "label": "Sprite" },
        { "id": "beer",        "label": "Beer" }
      ]
    },
    {
      "name": "Audio",
      "glowDuration": 0,
      "color": "#60a5fa",
      "buttons": [
        { "id": "partner-louder",  "label": "Partner louder" },
        { "id": "partner-quieter", "label": "Partner quieter" },
        { "id": "hall-louder",     "label": "Sound Hall louder" },
        { "id": "hall-quieter",    "label": "Sound Hall quieter" }
      ]
    },
    {
      "name": "Technical Issue",
      "glowDuration": 0,
      "color": "#f87171",
      "buttons": [
        { "id": "help", "label": "Help!!!" }
      ]
    },
    {
      "name": "Camera Positions",
      "glowDuration": 10,
      "color": "#facc15",
      "buttons": [
        { "id": "timeout-left",  "label": "Show timeout left" },
        { "id": "timeout-right", "label": "Show timeout right" },
        { "id": "line-left",     "label": "Show Line left" },
        { "id": "line-right",    "label": "Show Line right" }
      ]
    },
    {
      "name": "General",
      "glowDuration": 15,
      "color": "#a78bfa",
      "buttons": [
        { "id": "break",  "label": "Taking a break" },
        { "id": "yes",    "label": "Yes" },
        { "id": "no",     "label": "No" }
      ]
    },
    {
      "name": "Questions",
      "glowDuration": 60,
      "color": "#fb923c",
      "buttons": [
        { "id": "q-drinks", "label": "Drinks?" },
        { "id": "q-break",  "label": "Take a break?" }
      ]
    }
  ]
}
```

**Fields:**
- `screenGlow` — whether pressing any button flashes the full screen on all clients
- `groups[].glowDuration` — seconds a status stays active before auto-resetting; `0` means no timer (manual cancel only)
- `groups[].color` — drives button glow and screen flash color for that group
- `groups[].buttons[].id` — unique identifier used in WebSocket messages

---

## Server State (In-Memory)

```
clients: Map<WebSocket, { name: string, activeStatuses: Map<buttonId, timeoutHandle | null> }>
history: Array<{ clientName, buttonId, label, groupColor, timestamp }>  // capped at 200 entries
```

---

## WebSocket Protocol

### Client → Server

```jsonc
{ "type": "join",          "name": "Sven" }
{ "type": "status_set",    "buttonId": "water-gas" }
{ "type": "status_cancel", "buttonId": "water-gas" }
```

### Server → All Clients (broadcast)

```jsonc
// Sent only to the newly joined client — full current state
{
  "type": "init",
  "config": { /* full config.json contents */ },
  "clients": [
    { "name": "Anna", "activeStatuses": ["help"] }
  ],
  "history": [ /* up to 200 entries, newest first */ ]
}

// Broadcast when anyone joins
{ "type": "client_joined", "name": "Anna" }

// Broadcast when anyone disconnects
{ "type": "client_left", "name": "Anna" }

// Broadcast when a status changes (set, manually cancelled, or timer-expired)
{
  "type": "status_update",
  "clientName": "Sven",
  "buttonId": "water-gas",
  "label": "Water with gas",
  "groupColor": "#4ade80",
  "active": true
}

// Broadcast when a new history entry is added (only on status_set, not on cancel/expire)
{
  "type": "history_add",
  "clientName": "Sven",
  "label": "Water with gas",
  "groupColor": "#4ade80",
  "timestamp": "14:23:01"
}

// Sent only to the requesting client on a rejected join
{ "type": "error", "message": "Name already taken" }
```

### Timer Logic

- On `status_set`: if `glowDuration > 0`, server schedules a `setTimeout` for that many seconds, then broadcasts `status_update` with `active: false`. If `status_cancel` arrives before the timer fires, the timeout is cleared and the `active: false` broadcast goes out immediately.
- `glowDuration: 0`: no timer is set; status stays active until `status_cancel` is received.
- If a client sends `status_set` for a button that is already active, it is treated as `status_cancel` (toggle behavior mirrors the frontend).

---

## UI

### Join Screen

Full-screen centered layout. Single text input for the name + "Connect" button. Enter key submits. If the server returns `error: "Name already taken"`, the error is shown inline below the input without clearing it. No other validation — any non-empty name is accepted.

### Main View — Three Zones

**Top bar:**
- One badge per connected client, ordered by join time.
- Each badge shows the client name. Active statuses appear as small colored pills inside the badge, colored by their group color.
- The local client's own badge has a subtle highlight border so the user can identify themselves.

**Center area (scrollable):**
- Button groups rendered in order from config. Each group shows a label header and its buttons below.
- Active buttons show a pulsing `box-shadow` glow and a tinted background in the group's color.
- Pressing an active button sends `status_cancel`. Pressing an inactive button sends `status_set`.
- Multiple buttons can be active simultaneously across any groups.

**Right panel (fixed width, ~280px):**
- Scrolling history list, newest entry at top.
- Each entry: client name (colored by group color of the action), action label, timestamp (`HH:MM:SS`).
- Capped at 200 entries client-side (mirrors server cap).

### Visual Effects

**Button glow:** CSS `box-shadow` + background tint in the group's color, with a `@keyframes` pulse animation (slow 2s breathing effect while active).

**Screen glow:** When `screenGlow: true`, any `status_update` with `active: true` triggers a fixed `div` covering the full viewport. It fades from the group color at ~25% opacity to fully transparent over ~1 second, then is removed from the DOM. Multiple simultaneous statuses each trigger their own independent flash.

**No audio.** No sound effects on any client.

---

## Edge Cases

- **Duplicate name on join:** Server rejects with `error` message; client stays on join screen.
- **Client disconnect:** Server removes the client from `clients`, clears all their active status timeouts, and broadcasts `client_left`. Their entries remain in history.
- **Server restart:** All state is lost; clients must reload and re-enter their name.
- **Config reload:** Not supported at runtime; requires server restart.
- **Button id collision in config:** Not validated — config author is responsible for uniqueness.
