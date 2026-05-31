'use strict';

// ===== INIT STATE =====
const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const IS_CREATING = urlParams.get('create') === 'true';
let ROOM_ID = (urlParams.get('id') || '').toUpperCase();

let myId = null;
let myName = sessionStorage.getItem('syncwave_username') || '';
let currentPlatform = 'youtube';
let serverConfig = { spotifyEnabled: false, appleEnabled: false, youtubeSearchEnabled: false };

// Playback sync state
let isSyncing = false;
let pendingSyncState = null;  // stored when autoplay is blocked

// ===== AVATAR COLORS =====
const COLORS = [
  'linear-gradient(135deg,#7c3aed,#2563eb)',
  'linear-gradient(135deg,#ec4899,#7c3aed)',
  'linear-gradient(135deg,#06b6d4,#2563eb)',
  'linear-gradient(135deg,#10b981,#06b6d4)',
  'linear-gradient(135deg,#f59e0b,#ec4899)',
  'linear-gradient(135deg,#ef4444,#f59e0b)',
];
const colorMap = new Map();
function userColor(id) {
  if (!colorMap.has(id)) colorMap.set(id, COLORS[colorMap.size % COLORS.length]);
  return colorMap.get(id);
}

// ===== UTILS =====
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  el.innerHTML = `${icons[type]||icons.info}<span>${escHtml(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.style.transition='all .3s'; el.style.opacity='0'; el.style.transform='translateX(110%)'; setTimeout(()=>el.remove(),300); }, 3500);
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}

function escHtml(s) {
  return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function extractYtId(u) {
  if (!u) return null;
  const m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
         || u.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function openModal(id) { document.getElementById(id).style.display='flex'; }
function closeModal(id) { document.getElementById(id).style.display='none'; }
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if(e.target===o) closeModal(o.id); }));
document.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));

// ===== SYNC OVERLAY =====
// Chrome/Safari block autoplay triggered by socket events (no user gesture).
// We detect blocked autoplay and show this overlay so the user can click once.
function showSyncOverlay(state) {
  pendingSyncState = state;
  document.getElementById('sync-overlay').style.display = 'flex';
}
function hideSyncOverlay() {
  document.getElementById('sync-overlay').style.display = 'none';
  pendingSyncState = null;
}

document.getElementById('sync-now-btn').addEventListener('click', () => {
  const state = pendingSyncState;
  hideSyncOverlay();
  if (!state) return;

  if (currentPlatform === 'youtube') {
    applyYTState(state, true /* forced by user gesture */);
  } else if (currentPlatform === 'spotify') {
    applySpotifyState(state, true);
  } else if (currentPlatform === 'apple') {
    applyAppleState(state, true);
  }
});


// ===================================================
// ===== YOUTUBE PLAYER =====
// ===================================================
let ytPlayer = null;
let ytReady = false;
let ytDuration = 0;
let isPlaying = false;
let seekDragging = false;
let volumeBeforeMute = 80;
let syncTick = null;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('youtube-player', {
    height: '100%', width: '100%', videoId: '',
    playerVars: { controls: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, origin: location.origin },
    events: { onReady: onYTReady, onStateChange: onYTStateChange }
  });
};

function onYTReady() {
  ytReady = true;
  ytPlayer.setVolume(80);
  startSeekbarTick();
}

function onYTStateChange(event) {
  if (isSyncing) return;
  const s = event.data;
  if (s === YT.PlayerState.PLAYING) {
    isPlaying = true;
    updatePlayBtn(true);
    setWaveform(true);
    socket.emit('player-state', { platform: 'youtube', isPlaying: true, currentTime: ytPlayer.getCurrentTime(), lastUpdated: Date.now() });
  } else if (s === YT.PlayerState.PAUSED) {
    isPlaying = false;
    updatePlayBtn(false);
    setWaveform(false);
    socket.emit('player-state', { platform: 'youtube', isPlaying: false, currentTime: ytPlayer.getCurrentTime(), lastUpdated: Date.now() });
  } else if (s === YT.PlayerState.ENDED) {
    isPlaying = false;
    updatePlayBtn(false);
    setWaveform(false);
    playNextInQueue();
  }
}

function applyYTState(state, forcedGesture = false) {
  if (!ytReady || !ytPlayer) return;
  isSyncing = true;

  const elapsed = state.isPlaying ? (Date.now() - state.lastUpdated) / 1000 : 0;
  const target = (state.currentTime || 0) + elapsed;

  if (state.isPlaying) {
    ytPlayer.seekTo(target, true);
    ytPlayer.playVideo();

    // After 1.5s, check if browser actually started playing.
    // If not → autoplay was blocked → show sync overlay.
    if (!forcedGesture) {
      setTimeout(() => {
        try {
          const ps = ytPlayer.getPlayerState();
          if (ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING) {
            isSyncing = false;
            showSyncOverlay({ ...state, currentTime: target, lastUpdated: Date.now() });
            return;
          }
        } catch(e) {}
        isPlaying = true;
        updatePlayBtn(true);
        setWaveform(true);
        isSyncing = false;
      }, 1500);
    } else {
      isPlaying = true;
      updatePlayBtn(true);
      setWaveform(true);
      setTimeout(() => { isSyncing = false; }, 600);
    }
  } else {
    ytPlayer.seekTo(state.currentTime || 0, true);
    ytPlayer.pauseVideo();
    isPlaying = false;
    updatePlayBtn(false);
    setWaveform(false);
    setTimeout(() => { isSyncing = false; }, 400);
  }
}

function startSeekbarTick() {
  clearInterval(syncTick);
  syncTick = setInterval(() => {
    if (!ytPlayer || !ytReady || seekDragging || currentPlatform !== 'youtube') return;
    try {
      const cur = ytPlayer.getCurrentTime() || 0;
      const dur = ytPlayer.getDuration() || 0;
      if (dur > 0) {
        ytDuration = dur;
        document.getElementById('total-time').textContent = formatTime(dur);
        document.getElementById('current-time').textContent = formatTime(cur);
        const pct = (cur / dur) * 100;
        const sb = document.getElementById('seekbar');
        sb.value = pct;
        sb.style.setProperty('--progress', pct + '%');
      }
    } catch(e) {}
  }, 500);
}

// YouTube controls
document.getElementById('play-pause-btn').addEventListener('click', () => {
  if (currentPlatform === 'youtube') {
    if (!ytPlayer || !ytReady) return;
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
  } else if (currentPlatform === 'spotify') {
    toggleSpotifyPlayback();
  } else if (currentPlatform === 'apple') {
    toggleApplePlayback();
  }
});

document.getElementById('mute-btn').addEventListener('click', () => {
  if (currentPlatform !== 'youtube' || !ytPlayer || !ytReady) return;
  if (ytPlayer.isMuted()) {
    ytPlayer.unMute(); ytPlayer.setVolume(volumeBeforeMute);
    document.getElementById('vol-icon').style.display = 'block';
    document.getElementById('muted-icon').style.display = 'none';
  } else {
    volumeBeforeMute = ytPlayer.getVolume();
    ytPlayer.mute();
    document.getElementById('vol-icon').style.display = 'none';
    document.getElementById('muted-icon').style.display = 'block';
  }
});

document.getElementById('volume-slider').addEventListener('input', function() {
  if (currentPlatform !== 'youtube' || !ytPlayer || !ytReady) return;
  ytPlayer.setVolume(+this.value); ytPlayer.unMute();
  document.getElementById('vol-icon').style.display = +this.value > 0 ? 'block' : 'none';
  document.getElementById('muted-icon').style.display = +this.value > 0 ? 'none' : 'block';
});

document.getElementById('seekbar').addEventListener('mousedown', () => { seekDragging = true; });
document.getElementById('seekbar').addEventListener('touchstart', () => { seekDragging = true; }, { passive: true });
document.getElementById('seekbar').addEventListener('input', function() {
  const t = (+this.value / 100) * ytDuration;
  document.getElementById('current-time').textContent = formatTime(t);
  this.style.setProperty('--progress', this.value + '%');
});
document.getElementById('seekbar').addEventListener('change', function() {
  seekDragging = false;
  if (currentPlatform === 'youtube' && ytReady && ytDuration) {
    const t = (+this.value / 100) * ytDuration;
    isSyncing = true;
    ytPlayer.seekTo(t, true);
    setTimeout(() => { isSyncing = false; }, 300);
    socket.emit('player-state', { platform: 'youtube', isPlaying, currentTime: t, lastUpdated: Date.now() });
  }
});

document.getElementById('prev-btn').addEventListener('click', () => {
  if (currentPlatform === 'youtube' && ytReady) {
    isSyncing = true;
    ytPlayer.seekTo(0, true);
    setTimeout(() => { isSyncing = false; }, 300);
    socket.emit('player-state', { platform: 'youtube', isPlaying, currentTime: 0, lastUpdated: Date.now() });
  }
});
document.getElementById('next-btn').addEventListener('click', () => playNextInQueue());

document.getElementById('fullscreen-btn').addEventListener('click', () => {
  const w = document.getElementById('youtube-player-wrapper');
  document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.();
});

function updatePlayBtn(playing) {
  document.getElementById('play-icon').style.display = playing ? 'none' : 'block';
  document.getElementById('pause-icon').style.display = playing ? 'block' : 'none';
}
function setWaveform(playing) {
  const wf = document.getElementById('player-waveform');
  if (wf) wf.classList.toggle('paused', !playing);
}


// ===================================================
// ===== SPOTIFY — PKCE FLOW (no Client Secret needed) =====
// ===================================================
// PKCE = Proof Key for Code Exchange. Spotify recommends this for browser apps.
// No client_secret required. Redirect URI: http://localhost:3000/callback.html
// Spotify explicitly allows http://localhost as redirect URI.
// ===================================================
let spotifyPlayer    = null;
let spotifyDeviceId  = null;
let spotifyReady     = false;
let spotifyToken     = null;
let spotifyRefreshToken = null;
let spotifyTokenExpiry  = 0;
let spotifyClientId  = '';
let spotifyRedirectUri = '';

// PKCE helpers
function generateRandom(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), b => chars[b % chars.length]).join('');
}
async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function connectSpotify() {
  // Fetch client ID from server
  if (!spotifyClientId) {
    try {
      const r = await fetch('/api/spotify-config');
      const d = await r.json();
      spotifyClientId   = d.clientId;
      spotifyRedirectUri = d.redirectUri;
    } catch(e) {}
  }
  if (!spotifyClientId) {
    showToast('Spotify Client ID not set in .env', 'error');
    return;
  }

  // Generate PKCE verifier + challenge
  const verifier   = generateRandom(128);
  const challenge  = await pkceChallenge(verifier);
  sessionStorage.setItem('spotify_verifier', verifier);

  const params = new URLSearchParams({
    client_id:             spotifyClientId,
    response_type:         'code',
    redirect_uri:          spotifyRedirectUri,
    scope:                 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state',
    code_challenge_method: 'S256',
    code_challenge:        challenge,
    state:                 socket.id   // so callback knows which socket to notify
  });

  const popup = window.open(
    `https://accounts.spotify.com/authorize?${params}`,
    'spotify-auth', 'width=500,height=700,scrollbars=yes'
  );
  if (!popup) showToast('Allow popups to connect Spotify', 'error');
}

// callback.html sends us the code via postMessage
window.addEventListener('message', async (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.type !== 'spotify-callback') return;

  const { code } = event.data;
  const verifier = sessionStorage.getItem('spotify_verifier');
  if (!code || !verifier) { showToast('Spotify auth failed — no code/verifier', 'error'); return; }

  // Exchange code for tokens (PKCE — no secret needed)
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     spotifyClientId,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  spotifyRedirectUri,
        code_verifier: verifier
      })
    });
    const tokens = await r.json();
    if (tokens.error) { showToast('Spotify: ' + (tokens.error_description || tokens.error), 'error'); return; }

    spotifyToken       = tokens.access_token;
    spotifyRefreshToken = tokens.refresh_token;
    spotifyTokenExpiry  = Date.now() + (tokens.expires_in - 60) * 1000;
    sessionStorage.removeItem('spotify_verifier');
    loadSpotifySDK();
  } catch(e) {
    showToast('Spotify token exchange failed', 'error');
    console.error(e);
  }
});

async function getSpotifyToken() {
  if (Date.now() < spotifyTokenExpiry) return spotifyToken;
  // PKCE refresh — only needs client_id
  try {
    const r = await fetch('/auth/spotify/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: spotifyRefreshToken })
    });
    const d = await r.json();
    if (d.accessToken) {
      spotifyToken = d.accessToken;
      spotifyTokenExpiry = Date.now() + ((d.expiresIn || 3600) - 60) * 1000;
    }
  } catch(e) {}
  return spotifyToken;
}

function loadSpotifySDK() {
  if (window.Spotify) { initSpotifyPlayer(); return; }
  window.onSpotifyWebPlaybackSDKReady = initSpotifyPlayer;
  const s = document.createElement('script');
  s.src = 'https://sdk.scdn.co/spotify-player.js';
  document.body.appendChild(s);
}

function initSpotifyPlayer() {
  spotifyPlayer = new Spotify.Player({
    name: 'SyncWave',
    getOAuthToken: async cb => cb(await getSpotifyToken()),
    volume: 0.8
  });

  spotifyPlayer.addListener('ready', ({ device_id }) => {
    spotifyDeviceId = device_id;
    spotifyReady = true;
    updatePlatformUI('spotify');
    showToast('Spotify connected!', 'success');
    socket.emit('platform-ready', { platform: 'spotify' });
  });

  spotifyPlayer.addListener('not_ready', () => { spotifyReady = false; });

  spotifyPlayer.addListener('player_state_changed', (state) => {
    if (!state || isSyncing || currentPlatform !== 'spotify') return;
    const playing = !state.paused;
    isPlaying = playing;
    updatePlayBtn(playing);
    setWaveform(playing);

    // Update now-playing info from Spotify metadata
    const track = state.track_window?.current_track;
    if (track) {
      updateNowPlaying(track.name, track.artists?.[0]?.name, track.album?.images?.[0]?.url);
      document.getElementById('spotify-track-name').textContent = track.name;
      document.getElementById('spotify-artist-name').textContent = track.artists?.map(a=>a.name).join(', ') || '';
    }

    // Seekbar update for Spotify
    const pos = state.position / 1000;
    const dur = state.duration / 1000;
    if (dur > 0) {
      document.getElementById('current-time').textContent = formatTime(pos);
      document.getElementById('total-time').textContent = formatTime(dur);
      const pct = (pos / dur) * 100;
      const sb = document.getElementById('seekbar');
      if (!seekDragging) { sb.value = pct; sb.style.setProperty('--progress', pct + '%'); }
    }

    socket.emit('player-state', {
      platform: 'spotify',
      isPlaying: playing,
      currentTime: pos,
      lastUpdated: Date.now()
    });
  });

  spotifyPlayer.addListener('initialization_error', ({ message }) => showToast('Spotify init error: ' + message, 'error'));
  spotifyPlayer.addListener('authentication_error', ({ message }) => showToast('Spotify auth error — reconnect Spotify', 'error'));
  spotifyPlayer.addListener('account_error', () => showToast('Spotify Premium required', 'error'));

  spotifyPlayer.connect();
}

async function spotifyPlayUri(uri, positionMs = 0) {
  if (!spotifyDeviceId) return;
  const token = await getSpotifyToken();
  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri], position_ms: Math.round(positionMs) })
  });
}

async function applySpotifyState(state, forcedGesture = false) {
  if (!spotifyReady || !spotifyPlayer) {
    if (!forcedGesture) showSyncOverlay(state);
    return;
  }
  isSyncing = true;
  const elapsed = state.isPlaying ? (Date.now() - state.lastUpdated) / 1000 : 0;
  const posMs = ((state.currentTime || 0) + elapsed) * 1000;

  try {
    if (state.isPlaying) {
      if (state.uri) await spotifyPlayUri(state.uri, posMs);
      else { await spotifyPlayer.seek(posMs); await spotifyPlayer.resume(); }
      isPlaying = true; updatePlayBtn(true); setWaveform(true);
    } else {
      await spotifyPlayer.seek(posMs);
      await spotifyPlayer.pause();
      isPlaying = false; updatePlayBtn(false); setWaveform(false);
    }
  } catch(e) { console.error('Spotify sync error:', e); }

  setTimeout(() => { isSyncing = false; }, 600);
}

async function toggleSpotifyPlayback() {
  if (!spotifyPlayer || !spotifyReady) return;
  if (isPlaying) await spotifyPlayer.pause();
  else await spotifyPlayer.resume();
}

function seekbarChangeSpotify(pct) {
  if (!spotifyPlayer || !spotifyReady) return;
  // Spotify duration not easily available without state, use approximation
  spotifyPlayer.getCurrentState().then(state => {
    if (!state) return;
    const dur = state.duration;
    const posMs = (pct / 100) * dur;
    isSyncing = true;
    spotifyPlayer.seek(posMs).then(() => {
      socket.emit('player-state', { platform: 'spotify', isPlaying, currentTime: posMs/1000, lastUpdated: Date.now() });
      setTimeout(() => { isSyncing = false; }, 300);
    });
  });
}


// ===================================================
// ===== APPLE MUSIC (MusicKit JS) =====
// ===================================================
let appleMusicKit = null;
let appleReady = false;

async function connectAppleMusic() {
  try {
    const r = await fetch('/api/apple-token');
    const { developerToken } = await r.json();
    if (!developerToken) { showToast('Apple Music developer token not configured', 'error'); return; }

    // Load MusicKit JS dynamically
    if (!window.MusicKit) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    appleMusicKit = await MusicKit.configure({
      developerToken,
      app: { name: 'SyncWave', build: '1.0.0' }
    });

    await appleMusicKit.authorize();
    appleReady = true;
    updatePlatformUI('apple');
    showToast('Apple Music connected!', 'success');

    // Listen for playback state changes
    appleMusicKit.addEventListener(MusicKit.Events.playbackStateDidChange, () => {
      if (isSyncing || currentPlatform !== 'apple') return;
      const playing = appleMusicKit.playbackState === MusicKit.PlaybackStates.playing;
      isPlaying = playing;
      updatePlayBtn(playing);
      setWaveform(playing);
      socket.emit('player-state', {
        platform: 'apple',
        isPlaying: playing,
        currentTime: appleMusicKit.currentPlaybackTime,
        lastUpdated: Date.now()
      });
    });

    appleMusicKit.addEventListener(MusicKit.Events.nowPlayingItemDidChange, () => {
      const item = appleMusicKit.nowPlayingItem;
      if (item) {
        const art = item.artwork ? MusicKit.formatArtworkURL(item.artwork, 300, 300) : '';
        updateNowPlaying(item.attributes?.name, item.attributes?.artistName, art);
        document.getElementById('apple-track-name').textContent = item.attributes?.name || '—';
        document.getElementById('apple-artist-name').textContent = item.attributes?.artistName || '—';
        if (art) {
          document.getElementById('apple-album-art').style.backgroundImage = `url(${art})`;
          document.getElementById('apple-album-art').innerHTML = '';
        }
      }
    });

  } catch(e) {
    console.error('Apple Music error:', e);
    showToast('Apple Music connection failed', 'error');
  }
}

async function applePlayCatalog(catalogId, positionSec = 0) {
  if (!appleMusicKit || !appleReady) return;
  await appleMusicKit.setQueue({ song: catalogId });
  await appleMusicKit.play();
  if (positionSec > 0) appleMusicKit.seekToTime(positionSec);
}

async function applyAppleState(state, forcedGesture = false) {
  if (!appleReady || !appleMusicKit) {
    if (!forcedGesture) showSyncOverlay(state);
    return;
  }
  isSyncing = true;
  const elapsed = state.isPlaying ? (Date.now() - state.lastUpdated) / 1000 : 0;
  const target = (state.currentTime || 0) + elapsed;

  try {
    if (state.isPlaying) {
      appleMusicKit.seekToTime(target);
      await appleMusicKit.play();
      isPlaying = true; updatePlayBtn(true); setWaveform(true);
    } else {
      appleMusicKit.seekToTime(state.currentTime || 0);
      await appleMusicKit.pause();
      isPlaying = false; updatePlayBtn(false); setWaveform(false);
    }
  } catch(e) { console.error('Apple sync error:', e); }

  setTimeout(() => { isSyncing = false; }, 600);
}

async function toggleApplePlayback() {
  if (!appleMusicKit || !appleReady) return;
  if (isPlaying) await appleMusicKit.pause();
  else await appleMusicKit.play();
}


// ===================================================
// ===== LOAD MEDIA (all platforms) =====
// ===================================================
async function loadMedia(mediaInfo) {
  const { platform, videoId, uri, catalogId, url, title, thumbnail } = mediaInfo;
  currentPlatform = platform || 'youtube';

  // Hide all wrappers
  document.getElementById('player-empty').style.display = 'none';
  document.getElementById('youtube-player-wrapper').style.display = 'none';
  document.getElementById('spotify-player-wrapper').style.display = 'none';
  document.getElementById('apple-player-wrapper').style.display = 'none';
  document.getElementById('now-playing-bar').style.display = 'flex';

  updateNowPlaying(title, null, thumbnail);

  if (platform === 'youtube') {
    document.getElementById('youtube-player-wrapper').style.display = 'block';
    document.getElementById('custom-controls').style.display = 'block';
    if (ytReady && ytPlayer && videoId) {
      isSyncing = true;
      ytPlayer.loadVideoById(videoId, mediaInfo.currentTime || 0);
      setTimeout(() => {
        isSyncing = false;
        if (mediaInfo.isPlaying) ytPlayer.playVideo();
        else ytPlayer.pauseVideo();
      }, 800);
    }

  } else if (platform === 'spotify') {
    document.getElementById('spotify-player-wrapper').style.display = 'flex';
    document.getElementById('custom-controls').style.display = 'block';
    if (spotifyReady && uri) {
      const posMs = (mediaInfo.currentTime || 0) * 1000;
      await spotifyPlayUri(uri, posMs);
      if (!mediaInfo.isPlaying) setTimeout(() => spotifyPlayer.pause(), 1000);
    }

  } else if (platform === 'apple') {
    document.getElementById('apple-player-wrapper').style.display = 'flex';
    document.getElementById('custom-controls').style.display = 'block';
    if (appleReady && catalogId) {
      await applePlayCatalog(catalogId, mediaInfo.currentTime || 0);
      if (!mediaInfo.isPlaying) setTimeout(() => appleMusicKit.pause(), 1000);
    }
  }
}

function updateNowPlaying(title, artist, thumb) {
  document.getElementById('now-playing-title').textContent = title || 'Unknown';
  const thumbEl = document.getElementById('now-playing-thumb');
  if (thumb) {
    thumbEl.innerHTML = `<img src="${thumb}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">`;
  }
}


// ===================================================
// ===== PLATFORM TABS & INPUT =====
// ===================================================
function setPlatform(p) {
  currentPlatform = p;
  document.querySelectorAll('.platform-tab').forEach(t => t.classList.toggle('active', t.dataset.platform === p));

  const inp = document.getElementById('media-url-input');
  const hints = document.getElementById('platform-hints');
  document.getElementById('search-results-panel').style.display = 'none';

  if (p === 'youtube') {
    inp.placeholder = 'Paste YouTube URL or search...';
    hints.textContent = 'youtube.com/watch?v=..., youtu.be/..., or just paste a video ID';
  } else if (p === 'spotify') {
    inp.placeholder = 'Paste Spotify track/album/playlist URL...';
    hints.textContent = 'e.g. open.spotify.com/track/... · Spotify Premium required';
  } else if (p === 'apple') {
    inp.placeholder = 'Paste Apple Music URL or search...';
    hints.textContent = 'e.g. music.apple.com/... · Apple Music subscription required';
  }

  updatePlatformUI(p);
  inp.value = '';
}

document.querySelectorAll('.platform-tab').forEach(t => t.addEventListener('click', () => setPlatform(t.dataset.platform)));

async function handleMediaLoad() {
  const raw = document.getElementById('media-url-input').value.trim();
  if (!raw) return;

  if (currentPlatform === 'youtube') {
    const vid = extractYtId(raw);
    if (vid) {
      // Direct load
      let title = 'YouTube Video';
      let thumbnail = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
      try {
        const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`);
        if (r.ok) { const d = await r.json(); title = d.title||title; thumbnail = d.thumbnail_url||thumbnail; }
      } catch(e) {}
      socket.emit('load-media', { platform: 'youtube', videoId: vid, title, thumbnail });
      document.getElementById('media-url-input').value = '';
      document.getElementById('search-results-panel').style.display = 'none';
    } else if (serverConfig.youtubeSearchEnabled) {
      // Search
      searchYouTube(raw);
    } else {
      showToast('Invalid YouTube URL. Paste a full youtube.com or youtu.be link.', 'error');
    }

  } else if (currentPlatform === 'spotify') {
    if (!spotifyReady) { showToast('Connect your Spotify account first', 'error'); return; }
    if (!raw.includes('spotify.com')) { showToast('Paste a Spotify URL', 'error'); return; }
    // Extract URI: open.spotify.com/track/ABC -> spotify:track:ABC
    const match = raw.match(/spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
    if (!match) { showToast('Invalid Spotify URL', 'error'); return; }
    const uri = `spotify:${match[1]}:${match[2]}`;
    const title = match[1].charAt(0).toUpperCase() + match[1].slice(1) + ' on Spotify';
    socket.emit('load-media', { platform: 'spotify', videoId: '', uri, title, thumbnail: '' });
    document.getElementById('media-url-input').value = '';

  } else if (currentPlatform === 'apple') {
    if (!appleReady) { showToast('Connect your Apple Music account first', 'error'); return; }
    // Apple Music URL: music.apple.com/us/album/name/1234567?i=9876543
    const match = raw.match(/music\.apple\.com\/[^/]+\/(?:album|song|playlist)\/[^/]+\/(\d+)(?:\?i=(\d+))?/);
    if (!match) { showToast('Invalid Apple Music URL', 'error'); return; }
    const catalogId = match[2] || match[1]; // track id or album id
    const title = 'Apple Music Track';
    socket.emit('load-media', { platform: 'apple', videoId: '', catalogId, title, thumbnail: '' });
    document.getElementById('media-url-input').value = '';
  }
}

document.getElementById('media-load-btn').addEventListener('click', handleMediaLoad);
document.getElementById('media-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleMediaLoad();
});

// YouTube search with debounce
let searchTimer = null;
document.getElementById('media-url-input').addEventListener('input', function() {
  if (currentPlatform !== 'youtube' || !serverConfig.youtubeSearchEnabled) return;
  const q = this.value.trim();
  clearTimeout(searchTimer);
  if (!q || extractYtId(q)) { document.getElementById('search-results-panel').style.display = 'none'; return; }
  searchTimer = setTimeout(() => searchYouTube(q), 600);
});

async function searchYouTube(q) {
  try {
    const r = await fetch(`/api/youtube-search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (data.noKey) return;
    renderSearchResults(data.items || []);
  } catch(e) {}
}

function renderSearchResults(items) {
  const panel = document.getElementById('search-results-panel');
  if (!items.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = items.map(item => {
    const vid = item.id?.videoId;
    const title = item.snippet?.title || '';
    const thumb = item.snippet?.thumbnails?.default?.url || '';
    const channel = item.snippet?.channelTitle || '';
    return `<div class="search-result-item" onclick="loadYtSearch('${vid}','${escHtml(title).replace(/'/g,"\\'")}','${thumb}')">
      <img src="${thumb}" alt="" class="search-result-thumb" />
      <div class="search-result-info">
        <div class="search-result-title">${escHtml(title)}</div>
        <div class="search-result-sub">${escHtml(channel)}</div>
      </div>
    </div>`;
  }).join('');
}

window.loadYtSearch = (vid, title, thumb) => {
  document.getElementById('search-results-panel').style.display = 'none';
  document.getElementById('media-url-input').value = '';
  socket.emit('load-media', { platform: 'youtube', videoId: vid, title, thumbnail: thumb });
};


// ===== Platform connect UI =====
function updatePlatformUI(platform) {
  const banner = document.getElementById('platform-connect-banner');

  if (platform === 'youtube') {
    banner.style.display = 'none';
    return;
  }

  if (platform === 'spotify') {
    if (!serverConfig.spotifyEnabled) {
      banner.style.display = 'block';
      banner.innerHTML = `<div class="connect-banner warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Spotify not configured. Add <code>SPOTIFY_CLIENT_ID</code> &amp; <code>SPOTIFY_CLIENT_SECRET</code> to <code>.env</code>
      </div>`;
    } else if (!spotifyReady) {
      banner.style.display = 'block';
      banner.innerHTML = `<button class="connect-platform-btn spotify" onclick="connectSpotify()">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
        Connect Spotify
      </button>`;
    } else {
      banner.style.display = 'block';
      banner.innerHTML = `<div class="connect-banner success">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Spotify connected &amp; ready
      </div>`;
    }
    return;
  }

  if (platform === 'apple') {
    if (!serverConfig.appleEnabled) {
      banner.style.display = 'block';
      banner.innerHTML = `<div class="connect-banner warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Apple Music not configured. Add <code>APPLE_DEVELOPER_TOKEN</code> to <code>.env</code>
      </div>`;
    } else if (!appleReady) {
      banner.style.display = 'block';
      banner.innerHTML = `<button class="connect-platform-btn apple" onclick="connectAppleMusic()">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>
        Connect Apple Music
      </button>`;
    } else {
      banner.style.display = 'block';
      banner.innerHTML = `<div class="connect-banner success">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Apple Music connected &amp; ready
      </div>`;
    }
  }
}


// ===== QUEUE =====
let queueData = [];

function renderQueue(queue) {
  queueData = queue || [];
  document.getElementById('queue-count').textContent = queueData.length;
  const list = document.getElementById('queue-list');
  if (!queueData.length) {
    list.innerHTML = `<div class="queue-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><p>Queue is empty</p><span>Add songs above</span></div>`;
    return;
  }
  list.innerHTML = queueData.map(item => `
    <div class="queue-item" data-id="${item.id}">
      <div class="queue-item-thumb">
        ${item.thumbnail ? `<img src="${item.thumbnail}" alt="" onerror="this.style.display='none'">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
      </div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(item.title||'Unknown')}</div>
        <div class="queue-item-meta">by ${escHtml(item.addedBy||'?')}</div>
      </div>
      <div class="queue-item-actions">
        <button class="queue-action-btn play" onclick="playQueueItem('${item.id}')" title="Play now">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="queue-action-btn remove" onclick="removeQueueItem('${item.id}')" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`).join('');
}

window.playQueueItem = id => socket.emit('queue-play', { itemId: id });
window.removeQueueItem = id => socket.emit('queue-remove', { itemId: id });

function playNextInQueue() {
  if (queueData.length > 0) socket.emit('queue-play', { itemId: queueData[0].id });
}


// ===== USERS =====
function renderUsers(users) {
  document.querySelectorAll('#user-count, #users-badge').forEach(e => e.textContent = users.length);
  document.getElementById('users-list').innerHTML = users.map(u => {
    const col = userColor(u.id);
    const init = (u.name||'?').substring(0,2).toUpperCase();
    const badges = [
      u.isHost ? `<span class="user-badge host">Host</span>` : '',
      u.id === myId ? `<span class="user-badge you">You</span>` : '',
      u.voiceEnabled ? `<span class="user-badge voice">🎤</span>` : ''
    ].filter(Boolean).join('');
    return `<div class="user-card" data-id="${u.id}">
      <div class="user-avatar${u.isSpeaking?' speaking':''}" style="background:${col}">${init}</div>
      <div class="user-info">
        <div class="user-name">${escHtml(u.name)}</div>
        ${badges ? `<div class="user-badges">${badges}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}


// ===== CHAT =====
function renderMessage(msg) {
  const el = document.createElement('div');
  if (msg.type === 'system') {
    el.className = 'system-message';
    el.textContent = msg.message;
  } else {
    el.className = `chat-message${msg.userId===myId?' own':''}`;
    const col = userColor(msg.userId);
    const nameColor = col.includes('7c3aed') ? '#a78bfa' : col.includes('ec4899') ? '#f9a8d4' : col.includes('06b6d4') ? '#67e8f9' : '#86efac';
    const time = new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    el.innerHTML = `<div class="chat-message-header"><span class="chat-message-name" style="color:${nameColor}">${escHtml(msg.userName)}</span><span class="chat-message-time">${time}</span></div><div class="chat-message-body">${escHtml(msg.message)}</div>`;
  }
  const container = document.getElementById('chat-messages');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const inp = document.getElementById('chat-input');
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';
  socket.emit('chat-message', { message: msg });
}

document.getElementById('chat-send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();} });


// ===== VOICE CHAT (WebRTC) =====
let voiceEnabled = false, localStream = null;
const peers = new Map();
let audioCtx = null, speakDetect = null, isSpeakingNow = false;
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

async function toggleVoice() {
  if (!voiceEnabled) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceEnabled = true;
      document.getElementById('voice-toggle-btn').classList.add('active');
      document.getElementById('voice-btn-label').textContent = 'Leave Voice';
      document.getElementById('mic-on-icon').style.display = 'none';
      document.getElementById('mic-off-icon').style.display = 'block';
      document.getElementById('voice-status-badge').style.display = 'flex';
      setupSpeakDetect();
      socket.emit('voice-enable');
      showToast('Voice chat enabled', 'success');
    } catch(e) { showToast('Mic access denied', 'error'); }
  } else {
    voiceEnabled = false;
    localStream?.getTracks().forEach(t => t.stop()); localStream = null;
    peers.forEach((p,id) => { p.close(); removeAudio(id); }); peers.clear();
    clearInterval(speakDetect); audioCtx?.close(); audioCtx = null;
    document.getElementById('voice-toggle-btn').classList.remove('active');
    document.getElementById('voice-btn-label').textContent = 'Join Voice';
    document.getElementById('mic-on-icon').style.display = 'block';
    document.getElementById('mic-off-icon').style.display = 'none';
    document.getElementById('voice-status-badge').style.display = 'none';
    socket.emit('voice-disable');
  }
}

function setupSpeakDetect() {
  try {
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(localStream);
    const an = audioCtx.createAnalyser(); an.fftSize = 256;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    speakDetect = setInterval(() => {
      an.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0)/data.length;
      const speaking = avg > 18;
      if (speaking !== isSpeakingNow) { isSpeakingNow = speaking; socket.emit('speaking', { isSpeaking: speaking }); }
    }, 150);
  } catch(e) {}
}

async function createPeer(targetId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  peers.set(targetId, pc);
  localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => playAudio(targetId, e.streams[0]);
  pc.onicecandidate = e => e.candidate && socket.emit('webrtc-ice', { targetId, candidate: e.candidate });
  pc.onconnectionstatechange = () => { if (['disconnected','failed'].includes(pc.connectionState)) { pc.close(); peers.delete(targetId); removeAudio(targetId); } };
  if (initiator) { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc-offer', { targetId, offer }); }
  return pc;
}

function playAudio(id, stream) {
  let a = document.getElementById(`audio-${id}`);
  if (!a) { a = document.createElement('audio'); a.id=`audio-${id}`; a.autoplay=true; document.body.appendChild(a); }
  a.srcObject = stream;
}
function removeAudio(id) { document.getElementById(`audio-${id}`)?.remove(); }

document.getElementById('voice-toggle-btn').addEventListener('click', toggleVoice);


// ===== HEADER CONTROLS =====
document.getElementById('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Room code copied!', 'success'));
});

document.getElementById('share-btn').addEventListener('click', () => {
  document.getElementById('share-url-text').textContent = `${location.origin}/?room=${ROOM_ID}`;
  document.getElementById('share-code-text').textContent = ROOM_ID;
  openModal('share-modal');
});
document.getElementById('copy-url-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(`${location.origin}/?room=${ROOM_ID}`).then(() => showToast('Link copied!', 'success'));
});
document.getElementById('copy-share-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Code copied!', 'success'));
});
document.getElementById('leave-btn').addEventListener('click', () => { if(confirm('Leave the room?')) location.href='/'; });


// ===== MOBILE TABS =====
document.querySelectorAll('.mobile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mobile-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    const p = tab.dataset.panel;
    document.getElementById('left-panel').classList.remove('mobile-visible');
    document.getElementById('right-panel').classList.remove('mobile-visible');
    document.getElementById('main-panel').style.display = p==='player' ? '' : 'none';
    if (p==='queue') document.getElementById('left-panel').classList.add('mobile-visible');
    if (p==='chat'||p==='users') document.getElementById('right-panel').classList.add('mobile-visible');
  });
});


// ===== SOCKET EVENTS =====
socket.on('player-state', (state) => {
  if (!state) return;
  const p = state.platform || currentPlatform;
  if (p === 'youtube') applyYTState(state);
  else if (p === 'spotify') applySpotifyState(state);
  else if (p === 'apple') applyAppleState(state);
  updatePlayBtn(state.isPlaying);
  setWaveform(state.isPlaying);
  isPlaying = state.isPlaying;
});

socket.on('load-media', (mediaInfo) => {
  loadMedia(mediaInfo);
  showToast(`Now loading: ${mediaInfo.title || 'New media'}`, 'success');
});

socket.on('queue-update', renderQueue);
socket.on('chat-message', renderMessage);
socket.on('system-message', renderMessage);

socket.on('user-joined', ({ users }) => renderUsers(users));
socket.on('user-left', ({ userId, users }) => {
  renderUsers(users);
  const p = peers.get(userId); if (p) { p.close(); peers.delete(userId); } removeAudio(userId);
});
socket.on('user-voice-change', ({ users }) => renderUsers(users));
socket.on('user-speaking', ({ userId, isSpeaking }) => {
  document.querySelector(`.user-card[data-id="${userId}"] .user-avatar`)?.classList.toggle('speaking', isSpeaking);
});

// WebRTC
socket.on('voice-peers', async ({ peers: peerIds }) => {
  for (const id of peerIds) if (!peers.has(id)) await createPeer(id, true);
});
socket.on('webrtc-offer', async ({ fromId, offer }) => {
  if (!voiceEnabled) return;
  let pc = peers.get(fromId) || await createPeer(fromId, false);
  await pc.setRemoteDescription(offer);
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('webrtc-answer', { targetId: fromId, answer: ans });
});
socket.on('webrtc-answer', async ({ fromId, answer }) => { const p=peers.get(fromId); if(p) await p.setRemoteDescription(answer); });
socket.on('webrtc-ice', async ({ fromId, candidate }) => { const p=peers.get(fromId); if(p&&candidate) try{await p.addIceCandidate(candidate);}catch(e){} });


// ===== SETUP ROOM =====
function setupRoom(roomData) {
  document.getElementById('room-layout').style.display = 'grid';
  document.getElementById('header-room-name').textContent = roomData.name;
  document.getElementById('header-room-code').textContent = ROOM_ID;
  renderUsers(roomData.users);
  renderQueue(roomData.queue);
  roomData.messages.forEach(renderMessage);
  if (roomData.playerState?.videoId || roomData.playerState?.uri || roomData.playerState?.catalogId) {
    loadMedia(roomData.playerState);
    setTimeout(() => {
      const s = roomData.playerState;
      if (s.platform==='youtube') applyYTState(s);
      else if (s.platform==='spotify') applySpotifyState(s);
      else if (s.platform==='apple') applyAppleState(s);
    }, 2000);
  }
  // Initialize platform UI for youtube by default
  updatePlatformUI('youtube');
}

function showNameOverlay(onName) {
  document.getElementById('name-overlay').style.display = 'flex';
  const btn = document.getElementById('overlay-join-btn');
  const inp = document.getElementById('overlay-username');
  const err = document.getElementById('overlay-error');
  const submit = () => {
    const name = inp.value.trim(); if (!name) { inp.focus(); return; }
    myName = name; sessionStorage.setItem('syncwave_username', name);
    err.style.display = 'none'; onName(name);
  };
  btn.addEventListener('click', submit);
  inp.addEventListener('keydown', e => { if(e.key==='Enter') submit(); });
  setTimeout(() => inp.focus(), 100);
}

function enterRoom(roomId, name) {
  socket.emit('join-room', { roomId, userName: name }, res => {
    if (!res.success) {
      document.getElementById('name-overlay').style.display = 'flex';
      const err = document.getElementById('overlay-error');
      err.textContent = res.error || 'Could not join room.';
      err.style.display = 'block';
      return;
    }
    document.getElementById('name-overlay').style.display = 'none';
    setupRoom(res.roomData);
  });
}

function createAndEnterRoom(name, roomName) {
  document.getElementById('name-overlay').style.display = 'none';
  socket.emit('create-room', { userName: name, roomName }, res => {
    if (!res.success) { showToast('Failed to create room', 'error'); setTimeout(()=>location.href='/',1500); return; }
    ROOM_ID = res.roomId;
    history.replaceState({}, '', `/room.html?id=${res.roomId}`);
    setupRoom(res.roomData);
  });
}


// ===== INIT =====
async function init() {
  // Load server config to know which platforms are set up
  try {
    const r = await fetch('/api/config');
    serverConfig = await r.json();
  } catch(e) {}

  const savedName = sessionStorage.getItem('syncwave_username');

  if (IS_CREATING) {
    if (!savedName) { location.href = '/'; return; }
    myName = savedName;
    const roomName = sessionStorage.getItem('syncwave_create_roomname') || `${myName}'s Room`;
    sessionStorage.removeItem('syncwave_create_roomname');
    createAndEnterRoom(myName, roomName);
  } else if (ROOM_ID) {
    if (savedName) { myName = savedName; enterRoom(ROOM_ID, myName); }
    else showNameOverlay(name => enterRoom(ROOM_ID, name));
  } else {
    location.href = '/';
  }
}

let domReady = false, sockReady = false;
function tryInit() { if (domReady && sockReady) init(); }
socket.on('connect', () => { myId = socket.id; sockReady = true; tryInit(); });
document.addEventListener('DOMContentLoaded', () => { domReady = true; tryInit(); });
