module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const baseUrl = process.env.BASE_URL ||
    `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  res.json({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    redirectUri: `${baseUrl}/callback.html`
  });
};
