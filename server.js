'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** @type {Map<import('ws').WebSocket, { name: string, activeStatuses: Map<string, ReturnType<typeof setTimeout>|null> }>} */
const clients = new Map();

/** @type {Array<{ clientName: string, buttonId: string, label: string, groupColor: string, timestamp: string }>} */
const history = [];

const HISTORY_CAP = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getTimestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Find a button by id across all groups.
 * @param {string} buttonId
 * @returns {{ button: object, group: object }|null}
 */
function findButton(buttonId) {
  for (const group of config.groups) {
    for (const button of group.buttons) {
      if (button.id === buttonId) {
        return { button, group };
      }
    }
  }
  return null;
}

/**
 * Send JSON to all connected clients.
 * @param {object} data
 */
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Send JSON to a single client.
 * @param {import('ws').WebSocket} ws
 * @param {object} data
 */
function sendTo(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Ignore malformed messages
      return;
    }

    const clientInfo = clients.get(ws);

    // -----------------------------------------------------------------------
    // join
    // -----------------------------------------------------------------------
    if (msg.type === 'join') {
      const name = msg.name;

      // Validate name presence
      if (!name || typeof name !== 'string' || name.trim() === '') {
        sendTo(ws, { type: 'error', message: 'Invalid name' });
        return;
      }

      // Check for duplicate name (case-sensitive)
      for (const info of clients.values()) {
        if (info.name === name) {
          sendTo(ws, { type: 'error', message: 'Name already taken' });
          return;
        }
      }

      // Store client
      clients.set(ws, { name, activeStatuses: new Map() });

      // Build clients list for init
      const clientsList = [];
      for (const info of clients.values()) {
        clientsList.push({
          name: info.name,
          activeStatuses: Array.from(info.activeStatuses.keys()),
        });
      }

      // Send init only to the new client
      sendTo(ws, {
        type: 'init',
        config,
        clients: clientsList,
        history,
      });

      // Broadcast client_joined to all (including the new client)
      broadcast({ type: 'client_joined', name });
      return;
    }

    // -----------------------------------------------------------------------
    // All other messages require a joined client
    // -----------------------------------------------------------------------
    if (!clientInfo) {
      return;
    }

    // -----------------------------------------------------------------------
    // status_set
    // -----------------------------------------------------------------------
    if (msg.type === 'status_set') {
      const { buttonId } = msg;
      if (!buttonId) return;

      const found = findButton(buttonId);
      if (!found) return;

      const { button, group } = found;
      const label = button.label;
      const groupColor = group.color;
      const glowDuration = group.glowDuration;

      const isActive = clientInfo.activeStatuses.has(buttonId);

      if (isActive) {
        // Toggle: treat as cancel
        const handle = clientInfo.activeStatuses.get(buttonId);
        if (handle !== null && handle !== undefined) {
          clearTimeout(handle);
        }
        clientInfo.activeStatuses.delete(buttonId);

        broadcast({
          type: 'status_update',
          clientName: clientInfo.name,
          buttonId,
          label,
          groupColor,
          active: false,
        });
      } else {
        // Activate
        let handle = null;

        if (glowDuration > 0) {
          handle = setTimeout(() => {
            // On expiry: remove from activeStatuses and broadcast inactive
            if (clients.has(ws)) {
              const info = clients.get(ws);
              if (info && info.activeStatuses.has(buttonId)) {
                info.activeStatuses.delete(buttonId);
                broadcast({
                  type: 'status_update',
                  clientName: info.name,
                  buttonId,
                  label,
                  groupColor,
                  active: false,
                });
              }
            }
          }, glowDuration * 1000);
        }

        clientInfo.activeStatuses.set(buttonId, handle);

        broadcast({
          type: 'status_update',
          clientName: clientInfo.name,
          buttonId,
          label,
          groupColor,
          active: true,
        });

        // Add history entry
        const entry = {
          clientName: clientInfo.name,
          buttonId,
          label,
          groupColor,
          timestamp: getTimestamp(),
        };
        history.unshift(entry);
        if (history.length > HISTORY_CAP) {
          history.length = HISTORY_CAP;
        }

        broadcast({
          type: 'history_add',
          clientName: entry.clientName,
          label: entry.label,
          groupColor: entry.groupColor,
          timestamp: entry.timestamp,
        });
      }

      return;
    }

    // -----------------------------------------------------------------------
    // status_cancel
    // -----------------------------------------------------------------------
    if (msg.type === 'status_cancel') {
      const { buttonId } = msg;
      if (!buttonId) return;

      if (!clientInfo.activeStatuses.has(buttonId)) {
        // Not active — ignore silently
        return;
      }

      const found = findButton(buttonId);
      if (!found) return;

      const { button, group } = found;

      const handle = clientInfo.activeStatuses.get(buttonId);
      if (handle !== null && handle !== undefined) {
        clearTimeout(handle);
      }
      clientInfo.activeStatuses.delete(buttonId);

      broadcast({
        type: 'status_update',
        clientName: clientInfo.name,
        buttonId,
        label: button.label,
        groupColor: group.color,
        active: false,
      });

      return;
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;

    // Clear all active timeouts
    for (const handle of clientInfo.activeStatuses.values()) {
      if (handle !== null && handle !== undefined) {
        clearTimeout(handle);
      }
    }

    const name = clientInfo.name;
    clients.delete(ws);

    broadcast({ type: 'client_left', name });
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Sven status board running at http://localhost:${PORT}`);
});
