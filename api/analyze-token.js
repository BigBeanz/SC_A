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

/* -------------------------------------------------- */
/* CACHE HELPERS                                      */
/* -------------------------------------------------- */

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

/* -------------------------------------------------- */
/* UTILITIES                                          */
/* -------------------------------------------------- */

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

/* -------------------------------------------------- */
/* DexScreener                                        */
/* -------------------------------------------------- */

async function fetchDexScreener(contractAddress, chain) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`
    const res = await fetch(url)
    const json = await res.json()

    const pairs = json?.pairs || []

    const chainPairs = pairs.filter((p) => p.chainId === chain)

    const scoredPairs = (chainPairs.length ? chainPairs : pairs).map((p) => {
      const liquidity = safeNumber(p?.liquidity?.usd)
      const volume = safeNumber(p?.volume?.h24)

      return {
        pair: p,
        score: liquidity * 0.6 + volume * 0.4,
      }
    })

    const selected =
      scoredPairs.sort((a, b) => b.score - a.score)[0]?.pair || null

    return { pair: selected }
  } catch (e) {
    console.error("DexScreener error", e)
    return { pair: null }
  }
}

/* -------------------------------------------------- */
/* GoPlus Security                                    */
/* -------------------------------------------------- */

async function fetchGoPlus(contractAddress, goplusChain) {
  if (!goplusChain) return null

  try {
    const url =
      `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${contractAddress}`

    const res = await fetch(url)
    const json = await res.json()

    const tokenSecurity =
      json?.result?.[contractAddress.toLowerCase()] || {}

    const bool = (v) => (v === "1" ? true : v === "0" ? false : null)
    const pct = (v) =>
      v !== undefined && v !== null && v !== "" ? parseFloat(v) : null

    const ownerAddress = tokenSecurity.owner_address || null

    return {
      honeypot: bool(tokenSecurity.is_honeypot),
      mintable: bool(tokenSecurity.is_mintable),
      blacklist: bool(tokenSecurity.is_blacklisted),
      ownerRenounced:
        ownerAddress === ZERO_ADDRESS
          ? true
          : ownerAddress
          ? false
          : null,
      transferPausable: bool(tokenSecurity.transfer_pausable),
      proxyContract: bool(tokenSecurity.is_proxy),
      selfDestruct: bool(tokenSecurity.selfdestruct),
      hiddenOwner: bool(tokenSecurity.hidden_owner),
      canTakeBackOwnership: bool(tokenSecurity.can_take_back_ownership),
      slippageModifiable: bool(tokenSecurity.slippage_modifiable),
      tradingCooldown: bool(tokenSecurity.trading_cooldown),
      externalCall: bool(tokenSecurity.external_call),
      cannotBuy: bool(tokenSecurity.cannot_buy),
      cannotSellAll: bool(tokenSecurity.cannot_sell_all),
      buyTax: pct(tokenSecurity.buy_tax),
      sellTax: pct(tokenSecurity.sell_tax),
      ownerAddress,
      creatorAddress: tokenSecurity.creator_address || null,
      holderCount:
        tokenSecurity.holder_count !== undefined &&
        tokenSecurity.holder_count !== null &&
        tokenSecurity.holder_count !== ""
          ? parseInt(tokenSecurity.holder_count, 10)
          : null,
      isOpenSource: bool(tokenSecurity.is_open_source),
      ownerChangeBalance: bool(tokenSecurity.owner_change_balance),
      isWhitelisted: bool(tokenSecurity.is_in_dex),
    }
  } catch (e) {
    console.error("GoPlus error", e)
    return null
  }
}

/* -------------------------------------------------- */
/* Moralis Holders                                    */
/* -------------------------------------------------- */

async function fetchMoralisHolders(contractAddress, moralisChain) {
  if (!moralisChain || !process.env.MORALIS_API_KEY) return null

  try {
    const url =
      `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=${moralisChain}&limit=10`

    const res = await fetch(url, {
      headers: {
        "X-API-Key": process.env.MORALIS_API_KEY,
      },
    })

    const json = await res.json()
    const holders = json?.result || []

    if (!holders.length) return null

    const topHolderPercent = holders[0]?.percentage || null

    const top5Percent = holders
      .slice(0, 5)
      .reduce((sum, h) => sum + (h.percentage || 0), 0)

    const top10Percent = holders
      .slice(0, 10)
      .reduce((sum, h) => sum + (h.percentage || 0), 0)

    let whaleRisk = "Healthy"

    if (top10Percent > 60) whaleRisk = "High"
    else if (top10Percent > 40) whaleRisk = "Moderate"

    return {
      topHolderPercent,
      top5Percent,
      top10Percent,
      whaleRisk,
    }
  } catch (e) {
    console.error("Moralis error", e)
    return null
  }
}

/* -------------------------------------------------- */
/* MAIN HANDLER                                       */
/* -------------------------------------------------- */

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  try {

    const contractAddress = req.body?.contractAddress || req.body?.address
    const chain = req.body?.chain || "ethereum"

    if (!contractAddress) {
      return res.status(400).json({ error: "Missing contractAddress" })
    }

    const cacheKey = `${chain}:${contractAddress.toLowerCase()}`
    const cached = getCache(cacheKey)

    if (cached) {
      return res.status(200).json(cached)
    }

    const chainMap = {
      ethereum: { moralis: "eth", goplus: "1" },
      bsc: { moralis: "bsc", goplus: "56" },
      polygon: { moralis: "polygon", goplus: "137" },
      arbitrum: { moralis: "arbitrum", goplus: "42161" },
      pulsechain: { moralis: null, goplus: null },
    }

    const moralisChain = chainMap[chain]?.moralis || null
    const goplusChain = chainMap[chain]?.goplus || null

    const [dexResult, goplusResult, moralisResult] =
      await Promise.all([
        fetchDexScreener(contractAddress, chain),
        fetchGoPlus(contractAddress, goplusChain),
        fetchMoralisHolders(contractAddress, moralisChain),
      ])

    const pair = dexResult?.pair || null

    if (!pair) {
      return res.status(404).json({ error: "No liquidity pair found" })
    }

    const tokenName = pair?.baseToken?.name || "Unknown Token"
    const tokenSymbol = pair?.baseToken?.symbol || "UNKNOWN"

    const price = safeNumber(pair?.priceUsd)
    const liquidityUSD = safeNumber(pair?.liquidity?.usd)
    const marketCap = safeNumber(pair?.fdv)
    const volume24h = safeNumber(pair?.volume?.h24)
    const buys24h = safeInt(pair?.txns?.h24?.buys)
    const sells24h = safeInt(pair?.txns?.h24?.sells)

    const dexName = pair?.dexId || "unknown"
    const fdv = safeNumber(pair?.fdv)
    const scanTime = new Date().toISOString()

    const priceChange24h =
      pair?.priceChange?.h24 !== undefined &&
      pair?.priceChange?.h24 !== null
        ? Number(pair.priceChange.h24)
        : null

    const pairCreatedAt = pair?.pairCreatedAt
      ? new Date(pair.pairCreatedAt).toISOString()
      : null

    const securityData = { ...DEFAULT_SECURITY_DATA, ...(goplusResult || {}) }
    const holderData = { ...DEFAULT_HOLDER_DATA, ...(moralisResult || {}) }

    const liqRatio = marketCap > 0 ? liquidityUSD / marketCap : null
    const volRatio = liquidityUSD > 0 ? volume24h / liquidityUSD : null

    const sellPressure =
      buys24h + sells24h > 0
        ? sells24h / (buys24h + sells24h)
        : null

    const contractAgeDays =
      pairCreatedAt
        ? (Date.now() - new Date(pairCreatedAt).getTime()) / 86400000
        : null

    let score = 0
    const riskSignalSet = new Set()

    if (securityData.honeypot) score += 40
    if (securityData.cannotSellAll) score += 40
    if (securityData.cannotBuy) score += 25
    if (securityData.mintable) score += 15
    if (securityData.hiddenOwner) score += 20

    if (liquidityUSD < 10000) score += 20

    if (contractAgeDays !== null && contractAgeDays < 7)
      score += 20

    const riskScore = clamp(Math.round(score), 0, 100)

    const riskLevel =
      riskScore >= 60 ? "High"
      : riskScore >= 30 ? "Moderate"
      : "Low"

    const securityGrade =
      riskScore >= 60 ? "F"
      : riskScore >= 45 ? "D"
      : riskScore >= 30 ? "C"
      : riskScore >= 15 ? "B"
      : "A"

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

    return res.status(500).json({
      error: "Analyzer failed",
    })

  }
}