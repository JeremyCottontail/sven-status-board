'use strict';

// --- State ---
let ws = null;
let localName = null;
let config = null;
const clients = new Map(); // name → { activeStatuses: Set<buttonId> }

// --- DOM Refs ---
const joinScreen = document.getElementById('join-screen');
const mainView = document.getElementById('main-view');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const topBar = document.getElementById('top-bar');
const buttonArea = document.getElementById('button-area');
const historyList = document.getElementById('history-list');

// --- Helpers ---

function getButtonMeta(buttonId) {
  if (!config) return null;
  for (const group of config.groups) {
    for (const button of group.buttons) {
      if (button.id === buttonId) {
        return { label: button.label, color: group.color };
      }
    }
  }
  return null;
}

function triggerScreenGlow(color) {
  const div = document.createElement('div');
  div.className = 'screen-glow';
  div.style.setProperty('--glow-color', color);
  document.body.appendChild(div);
  div.addEventListener('animationend', () => div.remove());
}

// --- Rendering ---

function renderButtonGroups() {
  buttonArea.innerHTML = '';
  for (const group of config.groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'button-group';

    const header = document.createElement('h3');
    header.className = 'group-header';
    header.textContent = group.name;
    groupEl.appendChild(header);

    const buttonsEl = document.createElement('div');
    buttonsEl.className = 'group-buttons';

    for (const button of group.buttons) {
      const btn = document.createElement('button');
      btn.className = 'status-btn';
      btn.dataset.buttonId = button.id;
      btn.style.setProperty('--group-color', group.color);
      btn.textContent = button.label;
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) {
          ws.send(JSON.stringify({ type: 'status_cancel', buttonId: button.id }));
        } else {
          ws.send(JSON.stringify({ type: 'status_set', buttonId: button.id }));
        }
      });
      buttonsEl.appendChild(btn);
    }

    groupEl.appendChild(buttonsEl);
    buttonArea.appendChild(groupEl);
  }
}

function createClientBadge(name, activeStatuses) {
  const badge = document.createElement('div');
  badge.className = 'client-badge' + (name === localName ? ' self' : '');
  badge.dataset.name = name;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'badge-name';
  nameSpan.textContent = name;
  badge.appendChild(nameSpan);

  if (activeStatuses) {
    for (const buttonId of activeStatuses) {
      const meta = getButtonMeta(buttonId);
      if (meta) {
        const pill = createStatusPill(buttonId, meta.label, meta.color);
        badge.appendChild(pill);
      }
    }
  }

  return badge;
}

function createStatusPill(buttonId, label, color) {
  const pill = document.createElement('span');
  pill.className = 'status-pill';
  pill.dataset.buttonId = buttonId;
  pill.style.backgroundColor = color;
  pill.textContent = label;
  return pill;
}

function renderTopBar(clientsData) {
  topBar.innerHTML = '';
  for (const clientData of clientsData) {
    clients.set(clientData.name, { activeStatuses: new Set(clientData.activeStatuses || []) });
    const badge = createClientBadge(clientData.name, clientData.activeStatuses || []);
    topBar.appendChild(badge);
  }
}

function createHistoryEntry(entry) {
  const el = document.createElement('div');
  el.className = 'history-entry';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'history-name';
  nameSpan.style.color = entry.groupColor;
  nameSpan.textContent = entry.clientName;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'history-label';
  labelSpan.textContent = ' ' + entry.label;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'history-time';
  timeSpan.textContent = entry.timestamp;

  el.appendChild(nameSpan);
  el.appendChild(labelSpan);
  el.appendChild(timeSpan);
  return el;
}

function renderHistory(historyData) {
  historyList.innerHTML = '';
  for (const entry of historyData) {
    historyList.appendChild(createHistoryEntry(entry));
  }
}

// --- Message Handlers ---

function handleInit(msg) {
  config = msg.config;
  renderButtonGroups();
  renderTopBar(msg.clients || []);
  renderHistory(msg.history || []);

  joinScreen.style.display = 'none';
  mainView.style.display = 'flex';
}

function handleClientJoined(msg) {
  clients.set(msg.name, { activeStatuses: new Set() });
  const badge = createClientBadge(msg.name, []);
  topBar.appendChild(badge);
}

function handleClientLeft(msg) {
  clients.delete(msg.name);
  const badge = topBar.querySelector(`.client-badge[data-name="${CSS.escape(msg.name)}"]`);
  if (badge) badge.remove();
}

function handleStatusUpdate(msg) {
  // Update button active state
  const btn = buttonArea.querySelector(`[data-button-id="${CSS.escape(msg.buttonId)}"]`);
  if (btn) {
    btn.classList.toggle('active', msg.active);
  }

  // Update client badge pills
  const badge = topBar.querySelector(`.client-badge[data-name="${CSS.escape(msg.clientName)}"]`);
  if (badge) {
    const existingPill = badge.querySelector(`.status-pill[data-button-id="${CSS.escape(msg.buttonId)}"]`);
    if (msg.active) {
      if (!existingPill) {
        const pill = createStatusPill(msg.buttonId, msg.label, msg.groupColor);
        badge.appendChild(pill);
      }
    } else {
      if (existingPill) existingPill.remove();
    }
  }

  // Update local clients map
  const clientState = clients.get(msg.clientName);
  if (clientState) {
    if (msg.active) {
      clientState.activeStatuses.add(msg.buttonId);
    } else {
      clientState.activeStatuses.delete(msg.buttonId);
    }
  }

  // Screen glow
  if (msg.active && config && config.screenGlow) {
    triggerScreenGlow(msg.groupColor);
  }
}

function handleHistoryAdd(msg) {
  const entry = createHistoryEntry(msg);
  historyList.insertBefore(entry, historyList.firstChild);

  // Trim to 200 entries
  while (historyList.children.length > 200) {
    historyList.removeChild(historyList.lastChild);
  }
}

function handleError(msg) {
  joinError.textContent = msg.message;
  if (ws) {
    ws.close();
    ws = null;
  }
}

// --- WebSocket ---

function connectAndJoin(name) {
  joinError.textContent = '';
  joinBtn.disabled = true;
  nameInput.disabled = true;

  ws = new WebSocket('ws://' + location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name }));
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('Invalid JSON from server:', event.data);
      return;
    }

    switch (msg.type) {
      case 'init':
        localName = name;
        handleInit(msg);
        break;
      case 'client_joined':
        handleClientJoined(msg);
        break;
      case 'client_left':
        handleClientLeft(msg);
        break;
      case 'status_update':
        handleStatusUpdate(msg);
        break;
      case 'history_add':
        handleHistoryAdd(msg);
        break;
      case 'error':
        handleError(msg);
        joinBtn.disabled = false;
        nameInput.disabled = false;
        break;
      default:
        console.warn('Unknown message type:', msg.type);
    }
  };

  ws.onerror = () => {
    joinError.textContent = 'Connection error. Check that the server is running.';
    joinBtn.disabled = false;
    nameInput.disabled = false;
    ws = null;
  };

  ws.onclose = () => {
    // Only re-enable join UI if we never made it to main view
    if (mainView.style.display !== 'flex') {
      joinBtn.disabled = false;
      nameInput.disabled = false;
    }
  };
}

// --- Join UI ---

function attemptJoin() {
  const name = nameInput.value.trim();
  if (!name) {
    joinError.textContent = 'Please enter your name.';
    return;
  }
  connectAndJoin(name);
}

joinBtn.addEventListener('click', attemptJoin);

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptJoin();
});
