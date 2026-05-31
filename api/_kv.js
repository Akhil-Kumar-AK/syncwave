// Shared Upstash Redis client
// Env vars set automatically by Vercel when you connect an Upstash database:
//   UPSTASH_REDIS_REST_URL   and   UPSTASH_REDIS_REST_TOKEN
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = { kv };
