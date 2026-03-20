import { Request, Response, NextFunction } from 'express'
import Redis from 'ioredis'

const MAX_REQUESTS = 300  // per window
const WINDOW_SEC = 60     // 1 minute

export function createRateLimiter(redis: Redis) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next()

    // Use X-Real-IP from reverse proxy, fallback to socket
    const ip = (req.headers['x-real-ip'] as string) || req.ip || req.socket.remoteAddress || 'unknown'
    const key = `rl:${ip}`

    try {
      const current = await redis.incr(key)
      if (current === 1) {
        await redis.expire(key, WINDOW_SEC)
      }

      res.setHeader('X-RateLimit-Limit', MAX_REQUESTS)
      res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS - current))

      if (current > MAX_REQUESTS) {
        res.status(429).json({ error: 'Too many requests' })
        return
      }
    } catch {
      // Redis down — allow request (no rate limiting)
    }

    next()
  }
}
