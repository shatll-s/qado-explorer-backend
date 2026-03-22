import { Router } from 'express'
import Redis from 'ioredis'
import { NodeProxy } from './nodeProxy'

export function createRoutes(node: NodeProxy, redis?: Redis | null): Router {
  const router = Router()

  // GET /api/tip — current chain tip
  router.get('/tip', async (_req, res) => {
    try {
      const tip = await node.getTip()
      res.json(tip)
    } catch (err: any) {
      res.status(502).json({ error: 'Node unavailable', detail: err.message })
    }
  })

  // GET /api/network — network info
  router.get('/network', async (_req, res) => {
    try {
      const net = await node.getNetwork()
      res.json(net)
    } catch (err: any) {
      res.status(502).json({ error: 'Node unavailable', detail: err.message })
    }
  })

  // GET /api/node-health — node health
  router.get('/node-health', async (_req, res) => {
    try {
      const health = await node.getHealth()
      res.json(health)
    } catch (err: any) {
      res.status(502).json({ error: 'Node unavailable', detail: err.message })
    }
  })

  // GET /api/blocks?count=20 — latest blocks
  router.get('/blocks', async (req, res) => {
    try {
      const count = Math.min(parseInt(req.query.count as string) || 20, 100)
      const blocks = await node.getLatestBlocks(count)
      res.json(blocks)
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch blocks', detail: err.message })
    }
  })

  // GET /api/block/:id — block by height or hash
  router.get('/block/:id', async (req, res) => {
    try {
      const block = await node.getBlock(req.params.id)
      res.json(block)
    } catch (err: any) {
      res.status(err.message?.includes('404') ? 404 : 502).json({
        error: 'Block not found', detail: err.message
      })
    }
  })

  // GET /api/address/:addr — address info
  router.get('/address/:addr', async (req, res) => {
    try {
      const addr = req.params.addr.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(addr)) {
        res.status(400).json({ error: 'Invalid address format (expected 64-char hex)' })
        return
      }
      const info = await node.getAddress(addr)
      res.json(info)
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch address', detail: err.message })
    }
  })

  // GET /api/address/:addr/incoming — incoming transactions with cursor pagination
  router.get('/address/:addr/incoming', async (req, res) => {
    try {
      const addr = req.params.addr.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(addr)) {
        res.status(400).json({ error: 'Invalid address format (expected 64-char hex)' })
        return
      }
      const cursor = req.query.cursor as string | undefined
      const data = await node.getAddressIncoming(addr, cursor)
      res.json(data)
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch incoming transactions', detail: err.message })
    }
  })

  // GET /api/tx/:txid — transaction info (with optional block_ref for coinbase disambiguation)
  router.get('/tx/:txid', async (req, res) => {
    try {
      const txid = req.params.txid.toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(txid)) {
        res.status(400).json({ error: 'Invalid txid format (expected 64-char hex)' })
        return
      }
      const blockRef = req.query.block_ref as string | undefined
      const info = await node.getTx(txid, blockRef)
      res.json(info)
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch transaction', detail: err.message })
    }
  })

  // GET /api/stats — computed network stats (cached 15s)
  router.get('/stats', async (_req, res) => {
    try {
      if (redis) {
        try {
          const cached = await redis.get('stats')
          if (cached) { res.json(JSON.parse(cached)); return }
        } catch {}
      }

      const tip = await node.getTip()
      const tipHeight = parseInt(tip.height)
      const span = Math.min(100, tipHeight)
      const oldBlock = await node.getBlock((tipHeight - span).toString())
      const tipBlock = await node.getBlock(tipHeight.toString())

      const t1 = new Date(oldBlock.timestamp_utc).getTime() / 1000
      const t2 = new Date(tipBlock.timestamp_utc).getTime() / 1000
      const timeDiff = t2 - t1

      const avgBlockTime = timeDiff > 0 ? timeDiff / span : 0

      // hashrate from current target: difficulty = 2^256 / target, hashrate = difficulty / avgBlockTime
      let hashrate = 0
      let difficulty = 0
      try {
        const job = await node.getMiningJob()
        const target = BigInt('0x' + job.target)
        if (target > 0n) {
          difficulty = Number((2n ** 256n) / target)
          hashrate = avgBlockTime > 0 ? difficulty / avgBlockTime : 0
        }
      } catch {}

      const blockReward = 20 // QADO per block
      const totalSupply = blockReward * tipHeight

      const stats = {
        avg_block_time: Math.round(avgBlockTime * 10) / 10,
        hashrate: Math.round(hashrate),
        difficulty: Math.round(difficulty),
        total_supply: totalSupply,
        block_reward: blockReward,
        blocks_sampled: span
      }

      if (redis) {
        try { await redis.setex('stats', 15, JSON.stringify(stats)) } catch {}
      }

      res.json(stats)
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to compute stats', detail: err.message })
    }
  })

  // GET /api/search?q=... — search by height, hash, address, txid
  router.get('/search', async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim().toLowerCase()
      if (!q) {
        res.status(400).json({ error: 'Missing query parameter q' })
        return
      }

      // Numeric = block height
      if (/^\d+$/.test(q)) {
        const block = await node.getBlock(q)
        res.json({ type: 'block', data: block })
        return
      }

      // 64 hex chars = could be hash, address, or txid
      if (/^[0-9a-f]{64}$/.test(q)) {
        // Try address first (most common search)
        try {
          const addr = await node.getAddress(q)
          if (addr) { res.json({ type: 'address', data: addr }); return }
        } catch {}

        // Try block hash
        try {
          const block = await node.getBlock(q)
          if (block) { res.json({ type: 'block', data: block }); return }
        } catch {}

        // Try txid
        try {
          const tx = await node.getTxConfirmations(q)
          if (tx) { res.json({ type: 'tx', data: tx }); return }
        } catch {}
      }

      // Block hash can also be shorter with leading zeros
      if (/^[0-9a-f]+$/.test(q) && q.length > 10) {
        try {
          const block = await node.getBlock(q)
          if (block) { res.json({ type: 'block', data: block }); return }
        } catch {}
      }

      res.status(404).json({ error: 'Not found' })
    } catch (err: any) {
      res.status(502).json({ error: 'Search failed', detail: err.message })
    }
  })

  return router
}
