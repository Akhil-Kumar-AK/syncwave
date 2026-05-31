const { kv } = require('./_kv');
const { v4: uuidv4 } = require('uuid');

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing room ID' });
    try {
      const room = await kv.get(`room:${id.toUpperCase()}`);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      return res.json(room);
    } catch (err) {
      console.error('KV get error:', err);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  if (req.method === 'POST') {
    const { action, userName, roomName, roomId } = req.body || {};

    if (action === 'create') {
      if (!userName) return res.status(400).json({ error: 'Missing userName' });
      const newRoomId = generateRoomId();
      const room = {
        id: newRoomId,
        name: roomName || `${userName}'s Room`,
        createdAt: Date.now(),
        playerState: {
          platform: 'youtube', videoId: '', currentTime: 0,
          isPlaying: false, lastUpdated: Date.now(),
          title: '', thumbnail: '', uri: '', catalogId: '', duration: 0
        },
        queue: [],
        messages: [{
          id: uuidv4(), type: 'system',
          message: `${userName} created the room`,
          timestamp: Date.now()
        }]
      };
      try {
        await kv.set(`room:${newRoomId}`, room, { ex: 86400 });
        return res.json({ success: true, roomId: newRoomId });
      } catch (err) {
        console.error('KV set error:', err);
        return res.status(500).json({ error: 'Failed to create room' });
      }
    }

    if (action === 'check') {
      const rid = (roomId || '').toUpperCase().trim();
      if (!rid) return res.json({ success: false, error: 'No room code provided' });
      try {
        const room = await kv.get(`room:${rid}`);
        if (!room) return res.json({ success: false, error: 'Room not found. Check the code and try again.' });
        return res.json({ success: true });
      } catch (err) {
        return res.status(500).json({ error: 'Storage error' });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
