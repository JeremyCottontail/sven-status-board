'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** @type {Map<import('ws').WebSocket, { name: string, activeStatuses: Map<string, ReturnType<typeof setTimeout>|null> }>} */
const clients = new Map();

/** @type {Array<{ id: number, clientName: string, buttonId: string, label: string, groupColor: string, timestamp: string }>} */
const history = [];

const HISTORY_CAP = 200;
let nextHistoryId = 1;

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
const PORT = process.env.PORT || 3000;

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/server-info', (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT });
});

app.get('/api/qrcode', async (req, res) => {
  const url = `http://${getLocalIP()}:${PORT}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 256 });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send('QR generation failed');
  }
});

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

      // Broadcast client_joined to all other clients (new client already has itself in init)
      const payload = JSON.stringify({ type: 'client_joined', name });
      for (const [sock] of clients) {
        if (sock !== ws && sock.readyState === sock.OPEN) {
          sock.send(payload);
        }
      }
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
          id: nextHistoryId++,
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
          id: entry.id,
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

    // -----------------------------------------------------------------------
    // history_delete
    // -----------------------------------------------------------------------
    if (msg.type === 'history_delete') {
      const { id } = msg;
      if (!id) return;

      const idx = history.findIndex(e => e.id === id);
      if (idx === -1) return;

      // Only the entry's author can delete it
      if (history[idx].clientName !== clientInfo.name) return;

      const { buttonId, label, groupColor } = history[idx];
      history.splice(idx, 1);
      broadcast({ type: 'history_deleted', id });

      // If the button is still active for this client, cancel it
      if (clientInfo.activeStatuses.has(buttonId)) {
        const handle = clientInfo.activeStatuses.get(buttonId);
        if (handle !== null && handle !== undefined) clearTimeout(handle);
        clientInfo.activeStatuses.delete(buttonId);
        broadcast({ type: 'status_update', clientName: clientInfo.name, buttonId, label, groupColor, active: false });
      }

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
httpServer.listen(PORT, () => {
  console.log(`Sven status board running at http://localhost:${PORT}`);
});
