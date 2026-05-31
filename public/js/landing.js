'use strict';

const socket = io();

// Utility: show toast
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  toast.innerHTML = `${icon}<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Modal helpers
function openModal(id) {
  const modal = document.getElementById(id);
  modal.style.display = 'flex';
  // Focus first input
  const input = modal.querySelector('input');
  if (input) setTimeout(() => input.focus(), 50);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.style.display = 'none';
}

// Close on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Close buttons
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Open modals
document.getElementById('create-card').addEventListener('click', () => openModal('create-modal'));
document.getElementById('join-card').addEventListener('click', () => openModal('join-modal'));

// Create Room
document.getElementById('create-btn').addEventListener('click', createRoom);
document.getElementById('create-roomname').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
document.getElementById('create-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('create-roomname').focus(); });

function createRoom() {
  const userName = document.getElementById('create-username').value.trim();
  const roomName = document.getElementById('create-roomname').value.trim();

  if (!userName) {
    document.getElementById('create-username').focus();
    document.getElementById('create-username').style.borderColor = 'rgba(239,68,68,0.5)';
    setTimeout(() => { document.getElementById('create-username').style.borderColor = ''; }, 2000);
    return;
  }

  // Store in sessionStorage and let room.html create the room on its own socket
  sessionStorage.setItem('syncwave_username', userName);
  sessionStorage.setItem('syncwave_create_roomname', roomName || `${userName}'s Room`);
  window.location.href = '/room.html?create=true';
}

// Join Room
document.getElementById('join-btn').addEventListener('click', joinRoom);
document.getElementById('join-roomcode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
document.getElementById('join-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('join-roomcode').focus(); });

// Auto-uppercase room code
document.getElementById('join-roomcode').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function joinRoom() {
  const userName = document.getElementById('join-username').value.trim();
  const roomId = document.getElementById('join-roomcode').value.trim().toUpperCase();
  const errorEl = document.getElementById('join-error');

  errorEl.style.display = 'none';

  if (!userName) {
    document.getElementById('join-username').focus();
    return;
  }
  if (!roomId || roomId.length < 4) {
    document.getElementById('join-roomcode').focus();
    errorEl.textContent = 'Please enter a valid room code.';
    errorEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('join-btn');
  btn.disabled = true;
  btn.textContent = 'Joining...';

  sessionStorage.setItem('syncwave_username', userName);

  socket.emit('join-room', { userName, roomId }, (res) => {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>Join Room`;
    if (res.success) {
      window.location.href = `/room.html?id=${roomId}`;
    } else {
      errorEl.textContent = res.error || 'Could not join room.';
      errorEl.style.display = 'block';
    }
  });
}

// Check if there's a room ID in URL (e.g., from shared link)
const urlParams = new URLSearchParams(window.location.search);
const sharedRoomId = urlParams.get('room');
if (sharedRoomId) {
  document.getElementById('join-roomcode').value = sharedRoomId.toUpperCase();
  const savedName = sessionStorage.getItem('syncwave_username');
  if (savedName) document.getElementById('join-username').value = savedName;
  openModal('join-modal');
}
