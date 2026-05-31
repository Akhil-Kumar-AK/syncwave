const Pusher = require('pusher');

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER || 'us2',
  useTLS: true
});

// Vercel sometimes doesn't auto-parse the body — do it manually as fallback
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch {
        // Try URL-encoded
        const params = new URLSearchParams(data);
        resolve(Object.fromEntries(params));
      }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = await parseBody(req);
  const { socket_id, channel_name, user_id, user_name } = body;

  if (!socket_id || !channel_name) {
    return res.status(400).json({ error: 'Missing socket_id or channel_name', received: JSON.stringify(body) });
  }

  if (!channel_name.startsWith('presence-room-')) {
    return res.status(403).json({ error: 'Unauthorized channel' });
  }

  if (!process.env.PUSHER_SECRET) {
    return res.status(500).json({ error: 'PUSHER_SECRET not set in Vercel env vars' });
  }

  try {
    const auth = pusher.authorizeChannel(socket_id, channel_name, {
      user_id: user_id || socket_id,
      user_info: {
        name: user_name || 'Anonymous',
        joinedAt: Date.now()
      }
    });
    return res.json(auth);
  } catch (err) {
    console.error('Pusher auth error:', err);
    return res.status(500).json({ error: 'Auth failed: ' + err.message });
  }
};
