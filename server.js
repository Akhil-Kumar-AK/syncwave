require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SPOTIFY_REDIRECT = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/auth/spotify/callback`;

// ===== ROOMS =====
const rooms = new Map();

function getUserList(room) {
  return Array.from(room.users.entries()).map(([id, data]) => ({
    id, name: data.name, isMuted: data.isMuted,
    isHost: room.host === id,
    isSpeaking: data.isSpeaking || false,
    voiceEnabled: data.voiceEnabled || false
  }));
}

function getRoomData(room) {
  return {
    id: room.id, name: room.name,
    playerState: room.playerState,
    queue: room.queue,
    messages: room.messages.slice(-50),
    users: getUserList(room)
  };
}

// ===== SPOTIFY — PKCE (client-side, no secret needed) =====
// PKCE flow: client generates code_verifier/challenge, exchanges code for token itself.
// Redirect URI: http://localhost:3000/callback.html  (Spotify allows http://localhost)

// Serve Client ID to frontend (safe — no secret exposed)
app.get('/api/spotify-config', (req, res) => {
  res.json({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    redirectUri: `${process.env.BASE_URL || `http://localhost:${PORT}`}/callback.html`
  });
});

// PKCE token refresh — client sends refresh_token, we call Spotify with just client_id (no secret)
app.post('/auth/spotify/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token' });
  if (!process.env.SPOTIFY_CLIENT_ID) return res.status(400).json({ error: 'No client ID configured' });
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID   // PKCE refresh needs only client_id
      })
    });
    const data = await r.json();
    res.json({ accessToken: data.access_token, expiresIn: data.expires_in });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// ===== APPLE MUSIC =====
app.get('/api/apple-token', (req, res) => {
  res.json({ developerToken: process.env.APPLE_DEVELOPER_TOKEN || '' });
});

// ===== YOUTUBE SEARCH =====
app.get('/api/youtube-search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ items: [] });
  if (!process.env.YOUTUBE_API_KEY) return res.json({ items: [], noKey: true });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=12&key=${process.env.YOUTUBE_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.json({ items: [] });
  }
});

// ===== CONFIG (tells client which platforms are set up) =====
app.get('/api/config', (req, res) => {
  res.json({
    spotifyEnabled: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    appleEnabled: !!process.env.APPLE_DEVELOPER_TOKEN,
    youtubeSearchEnabled: !!process.env.YOUTUBE_API_KEY
  });
});

// ===== POPUP HTML HELPER =====
function popupHtml(message, success) {
  const color = success ? '#1db954' : '#ef4444';
  const icon = success ? '✓' : '✗';
  return `<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#060614;color:white;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}
    .c{text-align:center;padding:40px;}
    h2{color:${color};margin-bottom:12px;font-size:1.5rem;}
    p{color:#94a3b8;font-size:.9rem;}
  </style></head><body>
    <div class="c"><h2>${icon} ${message}</h2><p>This window will close automatically...</p></div>
    <script>setTimeout(()=>window.close(),1500);</script>
  </body></html>`;
}

// ===== SOCKET.IO ROOMS =====
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('create-room', ({ roomName, userName }, callback) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = {
      id: roomId,
      name: roomName || `${userName}'s Room`,
      host: socket.id,
      users: new Map(),
      playerState: {
        platform: 'youtube', videoId: '', currentTime: 0,
        isPlaying: false, lastUpdated: Date.now(),
        title: '', thumbnail: '', uri: '', duration: 0
      },
      queue: [], messages: []
    };
    room.users.set(socket.id, { name: userName, isMuted: false, isSpeaking: false, voiceEnabled: false });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    const msg = { id: uuidv4(), type: 'system', message: `${userName} created the room`, timestamp: Date.now() };
    room.messages.push(msg);
    callback({ success: true, roomId, roomData: getRoomData(room) });
    console.log(`[ROOM] Created ${roomId} by ${userName}`);
  });

  socket.on('join-room', ({ roomId, userName }, callback) => {
    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return callback({ success: false, error: 'Room not found. Check the code and try again.' });

    room.users.set(socket.id, { name: userName, isMuted: false, isSpeaking: false, voiceEnabled: false });
    socket.join(rid);
    socket.roomId = rid;
    socket.userName = userName;

    const msg = { id: uuidv4(), type: 'system', message: `${userName} joined`, timestamp: Date.now() };
    room.messages.push(msg);
    io.to(rid).emit('system-message', msg);
    socket.to(rid).emit('user-joined', { userId: socket.id, userName, users: getUserList(room) });
    callback({ success: true, roomData: getRoomData(room) });
  });

  socket.on('player-state', (state) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.playerState = { ...room.playerState, ...state, lastUpdated: Date.now() };
    socket.to(socket.roomId).emit('player-state', room.playerState);
  });

  socket.on('load-media', (mediaInfo) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.playerState = { ...mediaInfo, currentTime: 0, isPlaying: false, lastUpdated: Date.now() };
    io.to(socket.roomId).emit('load-media', room.playerState);
    const user = room.users.get(socket.id);
    const msg = { id: uuidv4(), type: 'system', message: `${user?.name || 'Someone'} loaded: ${mediaInfo.title || 'New media'}`, timestamp: Date.now() };
    room.messages.push(msg);
    io.to(socket.roomId).emit('system-message', msg);
  });

  socket.on('chat-message', ({ message }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !message?.trim()) return;
    const user = room.users.get(socket.id);
    const msg = { id: uuidv4(), userId: socket.id, userName: user?.name || 'Unknown', message: message.trim(), type: 'chat', timestamp: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 300) room.messages.shift();
    io.to(socket.roomId).emit('chat-message', msg);
  });

  socket.on('queue-add', (item) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    room.queue.push({ ...item, id: uuidv4(), addedBy: user?.name || 'Unknown', addedAt: Date.now() });
    io.to(socket.roomId).emit('queue-update', room.queue);
  });

  socket.on('queue-remove', ({ itemId }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.queue = room.queue.filter(i => i.id !== itemId);
    io.to(socket.roomId).emit('queue-update', room.queue);
  });

  socket.on('queue-play', ({ itemId }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const item = room.queue.find(i => i.id === itemId);
    if (!item) return;
    room.queue = room.queue.filter(i => i.id !== itemId);
    room.playerState = { ...item, currentTime: 0, isPlaying: true, lastUpdated: Date.now() };
    io.to(socket.roomId).emit('load-media', room.playerState);
    io.to(socket.roomId).emit('queue-update', room.queue);
  });

  // WebRTC voice
  socket.on('webrtc-offer', ({ targetId, offer }) => socket.to(targetId).emit('webrtc-offer', { fromId: socket.id, offer }));
  socket.on('webrtc-answer', ({ targetId, answer }) => socket.to(targetId).emit('webrtc-answer', { fromId: socket.id, answer }));
  socket.on('webrtc-ice', ({ targetId, candidate }) => socket.to(targetId).emit('webrtc-ice', { fromId: socket.id, candidate }));

  socket.on('voice-enable', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.voiceEnabled = true;
    io.to(socket.roomId).emit('user-voice-change', { userId: socket.id, voiceEnabled: true, users: getUserList(room) });
    const voicePeers = Array.from(room.users.entries()).filter(([id, u]) => id !== socket.id && u.voiceEnabled).map(([id]) => id);
    socket.emit('voice-peers', { peers: voicePeers });
  });

  socket.on('voice-disable', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) { user.voiceEnabled = false; user.isSpeaking = false; }
    io.to(socket.roomId).emit('user-voice-change', { userId: socket.id, voiceEnabled: false, users: getUserList(room) });
  });

  socket.on('speaking', ({ isSpeaking }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.isSpeaking = isSpeaking;
    socket.to(socket.roomId).emit('user-speaking', { userId: socket.id, isSpeaking });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    const userName = user?.name || 'Someone';
    room.users.delete(socket.id);

    if (room.users.size === 0) { rooms.delete(socket.roomId); return; }

    if (room.host === socket.id) {
      const [newHostId] = room.users.entries().next().value;
      room.host = newHostId;
      const hostMsg = { id: uuidv4(), type: 'system', message: `${room.users.get(newHostId)?.name} is now the host`, timestamp: Date.now() };
      room.messages.push(hostMsg);
      io.to(socket.roomId).emit('system-message', hostMsg);
    }

    const msg = { id: uuidv4(), type: 'system', message: `${userName} left`, timestamp: Date.now() };
    room.messages.push(msg);
    io.to(socket.roomId).emit('system-message', msg);
    io.to(socket.roomId).emit('user-left', { userId: socket.id, users: getUserList(room) });
  });
});

server.listen(PORT, () => console.log(`\n🎵 SyncWave → http://localhost:${PORT}\n`));
