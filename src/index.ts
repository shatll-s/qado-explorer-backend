import express from 'express'
import cors from 'cors'
import Redis from 'ioredis'
import { createNodeProxy } from './nodeProxy'
import { createRateLimiter } from './rateLimiter'
import { createRoutes } from './routes'

const PORT = parseInt(process.env.PORT || '3001')
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const NODE_URL = process.env.QADO_NODE_URL || 'http://localhost:18080'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

const app = express()
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    return Math.min(times * 1000, 30000)
  }
})

let redisLogged = false
redis.on('connect', () => console.log(`Redis connected: ${REDIS_URL}`))
redis.on('error', (err) => {
  if (!redisLogged) { console.warn(`Redis unavailable: ${err.message} (running without cache)`); redisLogged = true }
})

app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json())

const rateLimiter = createRateLimiter(redis)
app.use(rateLimiter)

const nodeProxy = createNodeProxy(NODE_URL, redis)
const routes = createRoutes(nodeProxy)
app.use('/api', routes)

// Health check (no rate limit)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qado Explorer Backend listening on :${PORT}`)
  console.log(`  Node: ${NODE_URL}`)
  console.log(`  Redis: ${REDIS_URL}`)
})
