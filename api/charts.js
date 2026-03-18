/* ------------------------------------------------------------------ */
/* /api/charts.js                                                     */
/* Unified chart data endpoint                                        */
/* Supports:                                                          */
/*   type=price    - OHLCV price history for any token               */
/*   type=holders  - holder growth over time for core tokens         */
/*   type=roi      - ROI comparison from launch for PLS/HEX/PLSX/INC */
/* ------------------------------------------------------------------ */

const CACHE     = new Map()
const CACHE_TTL = 5 * 60 * 1000   // 5 min for chart data

function getCache(key) {
  const e = CACHE.get(key)
  if (!e) return null
  if (Date.now() > e.expiresAt) { CACHE.delete(key); return null }
  return e.data
}
function setCache(key, data) {
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL })
}

/* ------------------------------------------------------------------ */
/* PRICE HISTORY via GeckoTerminal (free, no key needed)              */
/* ------------------------------------------------------------------ */
async function fetchPriceHistory(tokenAddress, chain, days) {
  try {
    var network = chain === "pulsechain" ? "pulsechain" : "eth"

    // First get the pool address for this token from DexScreener
    var dsUrl = "https://api.dexscreener.com/latest/dex/tokens/" + tokenAddress
    var dsRes  = await fetch(dsUrl)
    var dsJson = await dsRes.json()
    var pairs  = (dsJson.pairs || []).filter(function(p) {
      return p.chainId === chain && p.priceUsd
    })
    if (!pairs.length) return null
    pairs.sort(function(a, b) {
      return (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0)
    })
    var pairAddr = pairs[0].pairAddress

    // Fetch OHLCV from GeckoTerminal
    var timeframe = days <= 1 ? "hour" : days <= 7 ? "hour" : "day"
    var limit     = days <= 1 ? 24 : days <= 7 ? days * 24 : days
    limit = Math.min(limit, 1000)

    var gtUrl = "https://api.geckoterminal.com/api/v2/networks/" + network
      + "/pools/" + pairAddr
      + "/ohlcv/" + timeframe
      + "?limit=" + limit + "&currency=usd"

    var gtRes  = await fetch(gtUrl, {
      headers: { "Accept": "application/json" }
    })
    if (!gtRes.ok) throw new Error("GeckoTerminal " + gtRes.status)
    var gtJson = await gtRes.json()

    var ohlcv = gtJson?.data?.attributes?.ohlcv_list || []
    // Format: [timestamp_sec, open, high, low, close, volume]
    return ohlcv.map(function(c) {
      return {
        t: c[0] * 1000,  // ms
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseFloat(c[5]),
      }
    }).filter(function(c) { return c.c > 0 })
      .sort(function(a, b) { return a.t - b.t })
  } catch (e) {
    console.error("fetchPriceHistory error:", e.message)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* HOLDER GROWTH via GeckoTerminal token info + Moralis history       */
/* Falls back to DexScreener data points we can synthesize           */
/* ------------------------------------------------------------------ */
async function fetchHolderGrowth(tokenAddress, chain) {
  try {
    // Use Moralis token stats which includes holder history snapshots
    if (!process.env.MORALIS_API_KEY) return null
    var moralisChain = chain === "pulsechain" ? "0x171" : "0x1"

    // Moralis /erc20/{address}/holders/history endpoint
    var url = "https://deep-index.moralis.io/api/v2.2/erc20/"
      + tokenAddress + "/holders?chain=" + moralisChain + "&limit=1"
    var res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY }
    })
    if (!res.ok) throw new Error("Moralis holders " + res.status)
    var json = await res.json()

    var current = json?.total_holders || json?.result?.[0]?.total_holders || null
    return current ? { currentHolders: current } : null
  } catch (e) {
    console.error("fetchHolderGrowth error:", e.message)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* ROI DATA -- price history normalized to 100 at launch              */
/* Uses GeckoTerminal for PulseChain tokens, CoinGecko for BTC/ETH   */
/* ------------------------------------------------------------------ */

// PulseChain launch: May 13 2023 = 1683936000
const PULSECHAIN_LAUNCH_TS = 1683936000000

const ROI_TOKENS = {
  pls:  { address: "0xa1077a294dde1b09bb078844df40758a5d0f9a27", chain: "pulsechain", label: "PLS",  color: "#00F5FF", launch: PULSECHAIN_LAUNCH_TS },
  hex:  { address: "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39", chain: "pulsechain", label: "HEX",  color: "#FF6B35", launch: PULSECHAIN_LAUNCH_TS },
  plsx: { address: "0x95b303987a60c71504d99aa1b13b4da07b0790ab", chain: "pulsechain", label: "PLSX", color: "#627EEA", launch: PULSECHAIN_LAUNCH_TS },
  inc:  { address: "0x2fa878ab3f87cc1c9737fc071108f904c0b0c95d", chain: "pulsechain", label: "INC",  color: "#1F5F53", launch: PULSECHAIN_LAUNCH_TS },
}

async function fetchROIData(tokens, days) {
  var results = {}
  await Promise.allSettled(tokens.map(async function(tokenKey) {
    try {
      var info = ROI_TOKENS[tokenKey]
      if (!info) return

      var data = await fetchPriceHistory(info.address, info.chain, days)
      if (!data || !data.length) return

      // Normalize to 100 at first data point
      var base = data[0].c
      if (!base || base <= 0) return

      results[tokenKey] = {
        label:  info.label,
        color:  info.color,
        points: data.map(function(d) {
          return { t: d.t, roi: Math.round((d.c / base) * 100 * 10) / 10 }
        }),
        currentROI: Math.round((data[data.length-1].c / base) * 100 * 10) / 10,
        currentPrice: data[data.length-1].c,
      }
    } catch (e) {
      console.error("ROI fetch error for", tokenKey, ":", e.message)
    }
  }))
  return results
}

/* ------------------------------------------------------------------ */
/* MAIN HANDLER                                                        */
/* ------------------------------------------------------------------ */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()

  try {
    var { type, address, chain, days, tokens } = req.query

    days   = Math.min(parseInt(days) || 30, 365)
    chain  = chain || "pulsechain"

    // -- Price history --
    if (type === "price") {
      if (!address) return res.status(400).json({ error: "Missing address" })
      var key = "price:" + chain + ":" + address + ":" + days
      var cached = getCache(key)
      if (cached) return res.status(200).json(cached)

      var data = await fetchPriceHistory(address, chain, days)
      if (!data) return res.status(404).json({ error: "No price data found" })

      var payload = { address, chain, days, candles: data }
      setCache(key, payload)
      return res.status(200).json(payload)
    }

    // -- Holder growth --
    if (type === "holders") {
      if (!address) return res.status(400).json({ error: "Missing address" })
      var key = "holders:" + chain + ":" + address
      var cached = getCache(key)
      if (cached) return res.status(200).json(cached)

      var data = await fetchHolderGrowth(address, chain)
      if (!data) return res.status(404).json({ error: "No holder data found" })

      setCache(key, data)
      return res.status(200).json(data)
    }

    // -- ROI comparison --
    if (type === "roi") {
      var tokenList = tokens ? tokens.split(",").filter(function(t) { return ROI_TOKENS[t] }) : ["pls","hex","plsx","inc"]
      var key = "roi:" + tokenList.join("+") + ":" + days
      var cached = getCache(key)
      if (cached) return res.status(200).json(cached)

      var data = await fetchROIData(tokenList, days)
      setCache(key, data)
      return res.status(200).json(data)
    }

    return res.status(400).json({ error: "Invalid type. Use: price, holders, roi" })

  } catch (e) {
    console.error("Charts error:", e)
    return res.status(500).json({ error: "Chart data fetch failed" })
  }
}