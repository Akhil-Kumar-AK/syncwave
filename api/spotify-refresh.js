module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token' });
  if (!process.env.SPOTIFY_CLIENT_ID) return res.status(400).json({ error: 'Spotify not configured' });

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID
      })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    res.json({ accessToken: data.access_token, expiresIn: data.expires_in });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
};
