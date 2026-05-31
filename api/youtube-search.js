module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
};
