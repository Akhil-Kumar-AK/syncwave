module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ developerToken: process.env.APPLE_DEVELOPER_TOKEN || '' });
};
