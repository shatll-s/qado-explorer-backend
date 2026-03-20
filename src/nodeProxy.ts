import fetch from 'node-fetch'
import Redis from 'ioredis'

export interface NodeProxy {
  getTip(): Promise<any>
  getBlock(heightOrHash: string): Promise<any>
  getAddress(address: string): Promise<any>
  getTx(txid: string): Promise<any>
  getTxConfirmations(txid: string): Promise<any>
  getNetwork(): Promise<any>
  getHealth(): Promise<any>
  getLatestBlocks(count: number): Promise<any[]>
}

export function createNodeProxy(nodeUrl: string, redis: Redis | null): NodeProxy {
  async function nodeGet(path: string): Promise<any> {
    const url = `${nodeUrl}${path}`
    const resp = await fetch(url, { timeout: 10000 })
    if (!resp.ok) throw new Error(`Node ${path}: ${resp.status}`)
    return resp.json()
  }

  async function cached<T>(key: string, ttlSec: number, fetcher: () => Promise<T>): Promise<T> {
    if (redis) {
      try {
        const hit = await redis.get(key)
        if (hit) return JSON.parse(hit)
      } catch {}
    }
    const data = await fetcher()
    if (redis) {
      try {
        await redis.setex(key, ttlSec, JSON.stringify(data))
      } catch {}
    }
    return data
  }

  return {
    getTip() {
      return cached('tip', 3, () => nodeGet('/v1/tip'))
    },

    getBlock(heightOrHash: string) {
      // Blocks are immutable — cache long, except latest few
      return cached(`block:${heightOrHash}`, 300, () => nodeGet(`/v1/block/${heightOrHash}`))
    },

    getAddress(address: string) {
      return cached(`addr:${address}`, 10, () => nodeGet(`/v1/address/${address}`))
    },

    getTx(txid: string) {
      return cached(`tx-full:${txid}`, 30, () => nodeGet(`/v1/tx/${txid}`))
    },

    getTxConfirmations(txid: string) {
      return cached(`tx:${txid}`, 15, () => nodeGet(`/v1/tx/${txid}/confirmations`))
    },

    getNetwork() {
      return cached('network', 60, () => nodeGet('/v1/network'))
    },

    getHealth() {
      return cached('health', 10, () => nodeGet('/v1/health'))
    },

    async getLatestBlocks(count: number) {
      const tip = await this.getTip()
      const tipHeight = parseInt(tip.height)
      if (isNaN(tipHeight)) return []

      const blocks: any[] = []
      const start = Math.max(0, tipHeight - count + 1)

      // Fetch in parallel (batches of 10)
      for (let i = tipHeight; i >= start; i -= 10) {
        const batch = []
        for (let j = i; j > Math.max(i - 10, start - 1); j--) {
          batch.push(this.getBlock(j.toString()))
        }
        const results = await Promise.all(batch)
        blocks.push(...results)
      }

      return blocks
    }
  }
}
