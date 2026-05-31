module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    spotifyEnabled: !!process.env.SPOTIFY_CLIENT_ID,
    appleEnabled: !!process.env.APPLE_DEVELOPER_TOKEN,
    youtubeSearchEnabled: !!process.env.YOUTUBE_API_KEY,
    pusherKey: process.env.PUSHER_KEY || '',
    pusherCluster: process.env.PUSHER_CLUSTER || 'us2'
  });
};
