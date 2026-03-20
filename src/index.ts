import express from 'express'
import cors from 'cors'
import Redis from 'ioredis'
import { createNodeProxy } from './nodeProxy'
import { createRateLimiter } from './rateLimiter'
import { createRoutes } from './routes'

const PORT = parseInt(process.env.PORT || '3001')
const REDIS_URL = process.env.REDIS_URL || ''
const NODE_URL = process.env.QADO_NODE_URL || 'http://localhost:18080'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

const app = express()

// Redis is optional — if not configured or unavailable, run without cache
let redis: Redis | null = null
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 0,
    connectTimeout: 3000,
    lazyConnect: true,
    retryStrategy() { return null } // don't retry — run without cache
  })
  redis.connect().then(() => {
    console.log(`Redis connected: ${REDIS_URL}`)
  }).catch(() => {
    console.warn(`Redis unavailable — running without cache`)
    redis = null
  })
}

app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json())

if (redis) {
  app.use(createRateLimiter(redis))
}

const nodeProxy = createNodeProxy(NODE_URL, redis)
const routes = createRoutes(nodeProxy, redis)
app.use('/api', routes)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0', cache: redis ? 'redis' : 'none' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qado Explorer Backend listening on :${PORT}`)
  console.log(`  Node: ${NODE_URL}`)
  console.log(`  Cache: ${REDIS_URL || 'disabled'}`)
})
