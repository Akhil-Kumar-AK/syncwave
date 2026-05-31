const { kv } = require('./_kv');
const Pusher = require('pusher');
const { v4: uuidv4 } = require('uuid');

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER || 'us2',
  useTLS: true
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { roomId, event, data, socketId } = req.body || {};
  if (!roomId || !event) return res.status(400).json({ error: 'Missing required fields' });

  const rid = roomId.toUpperCase();
  const channel = `presence-room-${rid}`;
  const options = socketId ? { socket_id: socketId } : {};

  let room;
  try {
    room = await kv.get(`room:${rid}`);
    if (!room) return res.status(404).json({ error: 'Room not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Storage error' });
  }

  try {
    if (event === 'player-state') {
      room.playerState = { ...room.playerState, ...data, lastUpdated: Date.now() };
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'player-state', room.playerState, options);

    } else if (event === 'load-media') {
      room.playerState = { ...data, currentTime: 0, isPlaying: false, lastUpdated: Date.now() };
      const msg = {
        id: uuidv4(), type: 'system',
        message: `${data.loadedBy || 'Someone'} loaded: ${data.title || 'New media'}`,
        timestamp: Date.now()
      };
      room.messages.push(msg);
      if (room.messages.length > 100) room.messages = room.messages.slice(-100);
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      // Send load-media to everyone (including sender) so UI updates
      await pusher.trigger(channel, 'load-media', room.playerState);
      await pusher.trigger(channel, 'system-message', msg);

    } else if (event === 'chat-message') {
      const msgText = (data.message || '').trim();
      if (!msgText) return res.status(400).json({ error: 'Empty message' });
      const msg = {
        id: uuidv4(), userId: data.userId || '', userName: data.userName || 'Anonymous',
        message: msgText, type: 'chat', timestamp: Date.now()
      };
      room.messages.push(msg);
      if (room.messages.length > 300) room.messages = room.messages.slice(-300);
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'chat-message', msg, options);

    } else if (event === 'queue-add') {
      const item = { ...data, id: uuidv4(), addedAt: Date.now() };
      room.queue.push(item);
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'queue-update', room.queue);

    } else if (event === 'queue-remove') {
      room.queue = room.queue.filter(i => i.id !== data.itemId);
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'queue-update', room.queue);

    } else if (event === 'queue-play') {
      const item = room.queue.find(i => i.id === data.itemId);
      if (!item) return res.status(404).json({ error: 'Queue item not found' });
      room.queue = room.queue.filter(i => i.id !== data.itemId);
      room.playerState = { ...item, currentTime: 0, isPlaying: true, lastUpdated: Date.now() };
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'load-media', room.playerState);
      await pusher.trigger(channel, 'queue-update', room.queue);

    } else if (event === 'user-joined') {
      const msg = {
        id: uuidv4(), type: 'system',
        message: `${data.userName || 'Someone'} joined`,
        timestamp: Date.now()
      };
      room.messages.push(msg);
      if (room.messages.length > 300) room.messages = room.messages.slice(-300);
      await kv.set(`room:${rid}`, room, { ex: 86400 });
      await pusher.trigger(channel, 'system-message', msg, options);

    } else {
      return res.status(400).json({ error: 'Unknown event type' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Event handling error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
