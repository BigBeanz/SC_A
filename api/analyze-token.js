const PULSECHAIN_RPC = "https://rpc.pulsechain.com"
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

const CACHE_TTL_MS = 30 * 1000
const RESPONSE_CACHE = new Map()

const DEFAULT_SECURITY_DATA = {
  honeypot: null,
  mintable: null,
  blacklist: null,
  ownerRenounced: null,
  transferPausable: null,
  proxyContract: null,
  selfDestruct: null,
  hiddenOwner: null,
  canTakeBackOwnership: null,
  slippageModifiable: null,
  tradingCooldown: null,
  externalCall: null,
  cannotBuy: null,
  cannotSellAll: null,
  buyTax: null,
  sellTax: null,
  ownerAddress: null,
  creatorAddress: null,
  holderCount: null,
  isOpenSource: null,
  ownerChangeBalance: null,
  isWhitelisted: null,
}

const DEFAULT_HOLDER_DATA = {
  topHolderPercent: null,
  top5Percent: null,
  top10Percent: null,
  whaleRisk: null,
}

/* ------------------------------------------------------------------ */
/* CACHE HELPERS                                                       */
/* ------------------------------------------------------------------ */

function getCache(key) {
  const entry = RESPONSE_CACHE.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    RESPONSE_CACHE.delete(key)
    return null
  }
  return entry.data
}

function setCache(key, data) {
  RESPONSE_CACHE.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

/* ------------------------------------------------------------------ */
/* UTILITY HELPERS                                                     */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function safeInt(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  try {
    if (clean.length === 64) {
      return Buffer.from(clean, "hex").toString("utf8").replace(/\0/g, "").trim() || null
    }
    if (clean.length >= 128) {
      const len = parseInt(clean.slice(64, 128), 16)
      if (!Number.isNaN(len) && len > 0) {
        return Buffer.from(clean.slice(128, 128 + len * 2), "hex")
          .toString("utf8")
          .replace(/\0/g, "")
          .trim() || null
      }
    }
  } catch {}
  return null
}

function topicToAddress(topic) {
  if (!topic || typeof topic !== "string") return null
  const clean = topic.toLowerCase().replace(/^0x/, "")
  if (clean.length < 40) return null
  return `0x${clean.slice(-40)}`
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n
  return BigInt(hex)
}

/* ------------------------------------------------------------------ */
/* PULSECHAIN RPC                                                      */
/* ------------------------------------------------------------------ */

async function rpcCall(method, params) {
  const res = await fetch(PULSECHAIN_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const json = await res.json()
  if (json?.error) throw new Error(json.error.message || "RPC error")
  return json?.result
}

/* ------------------------------------------------------------------ */
/* DEXSCREENER                                                         */
/* ------------------------------------------------------------------ */

async function fetchDexScreener(contractAddress, chain) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`
    const res = await fetch(url)
    const json = await res.json()

    const pairs = json?.pairs || []
    const chainPairs = pairs.filter((p) => p.chainId === chain)

    const scoredPairs = (chainPairs.length ? chainPairs : pairs).map((p) => ({
      pair: p,
      score: safeNumber(p?.liquidity?.usd) * 0.6 + safeNumber(p?.volume?.h24) * 0.4,
    }))

    const selected = scoredPairs.sort((a, b) => b.score - a.score)[0]?.pair || null
    return { pair: selected }
  } catch (e) {
    console.error("DexScreener error", e)
    return { pair: null }
  }
}

/* ------------------------------------------------------------------ */
/* GOPLUS SECURITY                                                     */
/* ------------------------------------------------------------------ */

async function fetchGoPlus(contractAddress, goplusChain) {
  if (!goplusChain) return null

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${contractAddress}`
    const res = await fetch(url)
    const json = await res.json()

    const tokenSecurity = json?.result?.[contractAddress.toLowerCase()] || {}

    const bool = (v) => (v === "1" ? true : v === "0" ? false : null)
    const pct  = (v) => (v !== undefined && v !== null && v !== "" ? parseFloat(v) : null)

    const ownerAddress = tokenSecurity.owner_address || null

    return {
      honeypot:            bool(tokenSecurity.is_honeypot),
      mintable:            bool(tokenSecurity.is_mintable),
      blacklist:           bool(tokenSecurity.is_blacklisted),
      ownerRenounced:      ownerAddress === ZERO_ADDRESS ? true : ownerAddress ? false : null,
      transferPausable:    bool(tokenSecurity.transfer_pausable),
      proxyContract:       bool(tokenSecurity.is_proxy),
      selfDestruct:        bool(tokenSecurity.selfdestruct),
      hiddenOwner:         bool(tokenSecurity.hidden_owner),
      canTakeBackOwnership:bool(tokenSecurity.can_take_back_ownership),
      slippageModifiable:  bool(tokenSecurity.slippage_modifiable),
      tradingCooldown:     bool(tokenSecurity.trading_cooldown),
      externalCall:        bool(tokenSecurity.external_call),
      cannotBuy:           bool(tokenSecurity.cannot_buy),
      cannotSellAll:       bool(tokenSecurity.cannot_sell_all),
      buyTax:              pct(tokenSecurity.buy_tax),
      sellTax:             pct(tokenSecurity.sell_tax),
      ownerAddress,
      creatorAddress:      tokenSecurity.creator_address || null,
      holderCount:         tokenSecurity.holder_count ? parseInt(tokenSecurity.holder_count, 10) : null,
      isOpenSource:        bool(tokenSecurity.is_open_source),
      ownerChangeBalance:  bool(tokenSecurity.owner_change_balance),
      isWhitelisted:       bool(tokenSecurity.is_in_dex),
    }
  } catch (e) {
    console.error("GoPlus error", e)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* MORALIS HOLDERS                                                     */
/* ------------------------------------------------------------------ */

async function fetchMoralisHolders(contractAddress, moralisChain) {
  if (!moralisChain || !process.env.MORALIS_API_KEY) return null

  try {
    const url = `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=${moralisChain}&limit=10`
    const res = await fetch(url, {
      headers: { "X-API-Key": process.env.MORALIS_API_KEY },
    })

    const json = await res.json()
    const holders = json?.result || []
    if (!holders.length) return null

    const topHolderPercent = holders[0]?.percentage || null
    const top5Percent  = holders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0)
    const top10Percent = holders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0)

    let whaleRisk = "Healthy"
    if (top10Percent > 60) whaleRisk = "High"
    else if (top10Percent > 40) whaleRisk = "Moderate"

    return { topHolderPercent, top5Percent, top10Percent, whaleRisk }
  } catch (e) {
    console.error("Moralis error", e)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* PULSECHAIN TOKEN METADATA                                           */
/* ------------------------------------------------------------------ */

async function fetchPulsechainTokenMetadata(contractAddress) {
  try {
    const [nameHex, symbolHex] = await Promise.all([
      rpcCall("eth_call", [{ to: contractAddress, data: "0x06fdde03" }, "latest"]),
      rpcCall("eth_call", [{ to: contractAddress, data: "0x95d89b41" }, "latest"]),
    ])
    return {
      name:   decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
    }
  } catch (e) {
    console.error("PulseChain metadata error", e)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* PULSECHAIN HOLDER DISTRIBUTION                                      */
/* ------------------------------------------------------------------ */

async function fetchPulsechainHolderDistribution(contractAddress) {
  try {
    // Step 1: Get total supply
    const totalSupplyHex = await rpcCall("eth_call", [
      { to: contractAddress, data: "0x18160ddd" }, "latest"
    ])
    const totalSupply = hexToBigInt(totalSupplyHex)
    if (!totalSupply || totalSupply <= 0n) return null

    // Step 2: Scan a tight recent window (500k blocks ~ 2 weeks) to find active addresses
    const latestBlockHex = await rpcCall("eth_blockNumber", [])
    const latestBlock = parseInt(latestBlockHex, 16)
    if (Number.isNaN(latestBlock)) return null

    // Use 500k block chunks — small enough to reliably succeed on PulseChain RPC
    const SCAN_WINDOW = 500_000
    const fromBlock = Math.max(0, latestBlock - SCAN_WINDOW)

    // Collect unique addresses from recent Transfer events
    const addressSet = new Set()
    const CHUNK = 100_000
    let cur = fromBlock
    while (cur < latestBlock && addressSet.size < 500) {
      const toBlock = Math.min(cur + CHUNK - 1, latestBlock)
      try {
        const logs = await rpcCall("eth_getLogs", [{
          address:   contractAddress,
          fromBlock: `0x${cur.toString(16)}`,
          toBlock:   `0x${toBlock.toString(16)}`,
          topics:    [TRANSFER_TOPIC],
        }])
        if (Array.isArray(logs)) {
          for (const log of logs) {
            const from = topicToAddress(log?.topics?.[1])
            const to   = topicToAddress(log?.topics?.[2])
            if (from && from !== ZERO_ADDRESS) addressSet.add(from)
            if (to   && to   !== ZERO_ADDRESS) addressSet.add(to)
          }
        }
      } catch {}
      cur = toBlock + 1
    }

    if (addressSet.size === 0) return null

    // Step 3: Query live balances for each discovered address in parallel batches
    const addresses = [...addressSet]
    const BATCH = 20
    const balanceEntries = []

    for (let i = 0; i < addresses.length; i += BATCH) {
      const batch = addresses.slice(i, i + BATCH)
      const results = await Promise.allSettled(
        batch.map(addr => {
          // balanceOf(address) selector = 0x70a08231, padded address
          const data = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0")
          return rpcCall("eth_call", [{ to: contractAddress, data }, "latest"])
        })
      )
      for (let j = 0; j < batch.length; j++) {
        const r = results[j]
        if (r.status === "fulfilled" && r.value) {
          const bal = hexToBigInt(r.value)
          if (bal > 0n) balanceEntries.push({ address: batch[j], balance: bal })
        }
      }
    }

    if (!balanceEntries.length) return null

    // Step 4: Calculate percentages and sort
    const holders = balanceEntries
      .map(h => ({ ...h, percentage: Number((h.balance * 10000n) / totalSupply) / 100 }))
      .sort((a, b) => b.percentage - a.percentage)

    const topHolderPercent = holders[0]?.percentage || null
    const top5Percent  = holders.slice(0, 5).reduce((s, h) => s + (h.percentage || 0), 0)
    const top10Percent = holders.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0)

    let whaleRisk = "Healthy"
    if (top10Percent > 60) whaleRisk = "High"
    else if (top10Percent > 40) whaleRisk = "Moderate"

    return { topHolderPercent, top5Percent, top10Percent, whaleRisk, holderCount: holders.length }
  } catch (e) {
    console.error("PulseChain holder reconstruction error", e)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* PULSECHAIN CHUNKED LOG FALLBACK                                     */
/* ------------------------------------------------------------------ */

async function fetchPulsechainLogsChunked(contractAddress, latestBlock, fromBlock = 0) {
  const CHUNK_SIZE = 250000
  const MAX_CHUNKS = 40
  let from = fromBlock, chunkCount = 0
  const allLogs = []

  while (from <= latestBlock && chunkCount < MAX_CHUNKS) {
    const to = Math.min(from + CHUNK_SIZE - 1, latestBlock)
    try {
      const chunk = await rpcCall("eth_getLogs", [{
        address:   contractAddress,
        fromBlock: `0x${from.toString(16)}`,
        toBlock:   `0x${to.toString(16)}`,
        topics:    [TRANSFER_TOPIC],
      }])
      if (Array.isArray(chunk)) allLogs.push(...chunk)
    } catch {}
    from = to + 1
    chunkCount++
  }

  return allLogs
}

/* ================================================================== */
/* MAIN HANDLER                                                        */
/* ================================================================== */

module.exports = async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") return res.status(200).end()

  try {

    const contractAddress = req.body?.contractAddress || req.body?.address
    const chain = req.body?.chain || "ethereum"

    if (!contractAddress) {
      return res.status(400).json({ error: "Missing contractAddress" })
    }

    const cacheKey = `${chain}:${contractAddress.toLowerCase()}`
    const cached = getCache(cacheKey)
    if (cached) return res.status(200).json(cached)

    const chainMap = {
      ethereum:   { moralis: "eth",     goplus: "1"     },
      bsc:        { moralis: "bsc",     goplus: "56"    },
      polygon:    { moralis: "polygon", goplus: "137"   },
      arbitrum:   { moralis: "arbitrum",goplus: "42161" },
      pulsechain: { moralis: null,      goplus: null    },
    }

    const moralisChain = chainMap[chain]?.moralis || null
    const goplusChain  = chainMap[chain]?.goplus  || null

    const [dexResult, goplusResult, moralisResult, pulseMetaResult, pulseHolderResult] =
      await Promise.all([
        fetchDexScreener(contractAddress, chain),
        fetchGoPlus(contractAddress, goplusChain),
        fetchMoralisHolders(contractAddress, moralisChain),
        chain === "pulsechain" ? fetchPulsechainTokenMetadata(contractAddress)      : Promise.resolve(null),
        chain === "pulsechain" ? fetchPulsechainHolderDistribution(contractAddress) : Promise.resolve(null),
      ])

    const pair = dexResult?.pair || null

    if (!pair) {
      return res.status(404).json({ error: "No liquidity pair found" })
    }

    /* ---- Token identity ---- */
    const tokenName   = pair?.baseToken?.name   || pulseMetaResult?.name   || "Unknown Token"
    const tokenSymbol = pair?.baseToken?.symbol || pulseMetaResult?.symbol || "UNKNOWN"

    /* ---- Market data ---- */
    const price        = safeNumber(pair?.priceUsd)
    const liquidityUSD = safeNumber(pair?.liquidity?.usd)
    const marketCap    = safeNumber(pair?.fdv)
    const volume24h    = safeNumber(pair?.volume?.h24)
    const buys24h      = safeInt(pair?.txns?.h24?.buys)
    const sells24h     = safeInt(pair?.txns?.h24?.sells)
    const dexName      = pair?.dexId || "unknown"
    const fdv          = safeNumber(pair?.fdv)
    const scanTime     = new Date().toISOString()

    const priceChange24h = pair?.priceChange?.h24 !== undefined && pair?.priceChange?.h24 !== null
      ? Number(pair.priceChange.h24) : null

    const pairCreatedAt = pair?.pairCreatedAt
      ? new Date(pair.pairCreatedAt).toISOString() : null

    /* ---- Security + holder data ---- */
    const securityData = { ...DEFAULT_SECURITY_DATA, ...(goplusResult || {}) }
    const holderData   = { ...DEFAULT_HOLDER_DATA,   ...(moralisResult || pulseHolderResult || {}) }

    // Backfill holderCount from PulseChain RPC if GoPlus didn't return it
    if (securityData.holderCount == null && pulseHolderResult?.holderCount != null) {
      securityData.holderCount = pulseHolderResult.holderCount
    }

    /* ---- Pre-calculated metrics ---- */
    const liqRatio       = marketCap > 0              ? liquidityUSD / marketCap               : null
    const volRatio       = liquidityUSD > 0           ? volume24h    / liquidityUSD            : null
    const sellPressure   = buys24h + sells24h > 0     ? sells24h     / (buys24h + sells24h)    : null
    const contractAgeDays= pairCreatedAt
      ? (Date.now() - new Date(pairCreatedAt).getTime()) / 86400000 : null

    /* ---------------------------------------------------------------- */
    /* RISK SCORE                                                        */
    /* ---------------------------------------------------------------- */

    let score = 0
    const riskSignalSet = new Set()

    // — Contract / control risks (GoPlus) —
    if (securityData.honeypot === true)             { score += 40; riskSignalSet.add("honeypot") }
    if (securityData.cannotSellAll === true)         { score += 40; riskSignalSet.add("cannotSellAll") }
    if (securityData.cannotBuy === true)             { score += 25; riskSignalSet.add("cannotBuy") }
    if (securityData.mintable === true)              { score += 15; riskSignalSet.add("mintable") }
    if (securityData.ownerRenounced === false)       { score += 10; riskSignalSet.add("ownerRenounced") }
    if (securityData.hiddenOwner === true)           { score += 20; riskSignalSet.add("hiddenOwner") }
    if (securityData.selfDestruct === true)          { score += 20; riskSignalSet.add("selfDestruct") }
    if (securityData.blacklist === true)             { score += 10; riskSignalSet.add("blacklist") }
    if (securityData.transferPausable === true)      { score += 10; riskSignalSet.add("transferPausable") }
    if (securityData.proxyContract === true)         { score += 8;  riskSignalSet.add("proxyContract") }
    if (securityData.canTakeBackOwnership === true)  { score += 15; riskSignalSet.add("canTakeBackOwnership") }
    if ((securityData.sellTax ?? 0) > 10)            { score += 10; riskSignalSet.add("highSellTax") }

    // — Liquidity risks —
    if (liquidityUSD < 10000)                        { score += 20; riskSignalSet.add("lowLiquidity") }
    if (liqRatio !== null && liqRatio < 0.02)        { score += 25; riskSignalSet.add("extremeLiquidityRisk") }
    else if (liqRatio !== null && liqRatio < 0.05)   { score += 15; riskSignalSet.add("lowLiquiditySupport") }
    if (volRatio !== null && volRatio > 8)            { score += 15; riskSignalSet.add("washTradingSuspected") }

    // — Whale concentration risks —
    if ((holderData.topHolderPercent ?? 0) > 20)     { score += 10; riskSignalSet.add("highTopHolderConcentration") }
    if ((holderData.top5Percent ?? 0) > 40)           { score += 25; riskSignalSet.add("whaleConcentration") }
    if ((holderData.top10Percent ?? 0) > 60)          { score += 30; riskSignalSet.add("extremeWhaleControl") }

    // — Market health signals (DexScreener — always available) —
    if (priceChange24h !== null) {
      const drop = Math.abs(Math.min(0, priceChange24h))
      if (drop >= 50)      { score += 30; riskSignalSet.add("severeDropDetected") }
      else if (drop >= 25) { score += 18; riskSignalSet.add("significantDropDetected") }
      else if (drop >= 15) { score += 8;  riskSignalSet.add("priceDropDetected") }
    }

    if (contractAgeDays !== null) {
      if (contractAgeDays < 1)       { score += 30; riskSignalSet.add("veryNewToken") }
      else if (contractAgeDays < 7)  { score += 20; riskSignalSet.add("newToken") }
      else if (contractAgeDays < 30) { score += 8;  riskSignalSet.add("recentToken") }
    }

    if (contractAgeDays !== null && contractAgeDays < 7 && liquidityUSD < 50000) {
      score += 20; riskSignalSet.add("newTokenLowLiquidity")
    }

    if (sellPressure !== null) {
      if (sellPressure > 0.75)      { score += 20; riskSignalSet.add("heavySellPressure") }
      else if (sellPressure > 0.65) { score += 10; riskSignalSet.add("elevatedSellPressure") }
    }

    const marketActivityRatio = marketCap > 0 ? volume24h / marketCap : null
    if (marketActivityRatio !== null && marketActivityRatio < 0.001 && marketCap > 10000) {
      score += 12; riskSignalSet.add("lowMarketActivity")
    }
    if (volume24h < 500 && marketCap > 5000) {
      score += 15; riskSignalSet.add("inactiveToken")
    }

    const riskScore     = clamp(Math.round(score), 0, 100)
    const riskLevel     = riskScore >= 60 ? "High" : riskScore >= 30 ? "Moderate" : "Low"
    const securityGrade = riskScore >= 60 ? "F" : riskScore >= 45 ? "D" : riskScore >= 30 ? "C" : riskScore >= 15 ? "B" : "A"
    const riskSignals   = Array.from(riskSignalSet)

    /* ---------------------------------------------------------------- */
    /* RESPONSE                                                          */
    /* ---------------------------------------------------------------- */

    const responsePayload = {
      tokenName,
      tokenSymbol,
      address: contractAddress,
      chain,

      price,
      liquidityUSD,
      marketCap,
      volume24h,
      buys24h,
      sells24h,
      priceChange24h,
      dexName,
      pairCreatedAt,
      fdv,
      scanTime,

      riskScore,
      riskLevel,
      securityGrade,
      riskSignals,

      contractAgeDays,
      sellPressure,
      liqRatio,
      volRatio,

      ...securityData,
      ...holderData,
    }

    setCache(cacheKey, responsePayload)
    return res.status(200).json(responsePayload)

  } catch (error) {
    console.error("Analyzer error:", error)
    return res.status(500).json({ error: "Analyzer failed" })
  }
}