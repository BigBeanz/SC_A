const PULSECHAIN_RPC = "https://rpc.pulsechain.com"
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// --------------------------------
// SIMPLE IN-MEMORY CACHE
// --------------------------------

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

    const [dexResult, goplusResult, moralisResult, pulseMetaResult, pulseHolderResult] =
      await Promise.all([
        fetchDexScreener(contractAddress, chain),
        fetchGoPlus(contractAddress, goplusChain),
        fetchMoralisHolders(contractAddress, moralisChain),
        chain === "pulsechain"
          ? fetchPulsechainTokenMetadata(contractAddress)
          : Promise.resolve(null),
        chain === "pulsechain"
          ? fetchPulsechainHolderDistribution(contractAddress)
          : Promise.resolve(null),
      ])

    const pair = dexResult?.pair || null

    // --------------------------------
    // TOKEN IDENTITY
    // --------------------------------

    const tokenName =
      pair?.baseToken?.name ||
      pulseMetaResult?.name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      pulseMetaResult?.symbol ||
      "UNKNOWN"

    // --------------------------------
    // MARKET DATA
    // --------------------------------

    const price = safeNumber(pair?.priceUsd)
    const liquidityUSD = safeNumber(pair?.liquidity?.usd)
    const marketCap = safeNumber(pair?.fdv)
    const volume24h = safeNumber(pair?.volume?.h24)

    const buys24h = safeInt(pair?.txns?.h24?.buys)
    const sells24h = safeInt(pair?.txns?.h24?.sells)

    const dexName = pair?.dexId || "unknown"

    const pairCreatedAt = pair?.pairCreatedAt
      ? new Date(pair.pairCreatedAt).toISOString()
      : null

    const priceChange24h =
      pair?.priceChange?.h24 !== undefined && pair?.priceChange?.h24 !== null
        ? Number(pair.priceChange.h24)
        : null

    const fdv = safeNumber(pair?.fdv)
    const scanTime = new Date().toISOString()

    // --------------------------------
    // SECURITY + HOLDERS
    // --------------------------------

    const securityData = {
      ...DEFAULT_SECURITY_DATA,
      ...(goplusResult || {}),
    }

    const holderData = {
      ...DEFAULT_HOLDER_DATA,
      ...(moralisResult || pulseHolderResult || {}),
    }

    if (securityData.holderCount == null && pulseHolderResult?.holderCount != null) {
      securityData.holderCount = pulseHolderResult.holderCount
    }

    // --------------------------------
    // PRE-CALCULATED METRICS
    // --------------------------------

    const liqRatio =
      marketCap > 0 ? liquidityUSD / marketCap : null

    const volRatio =
      liquidityUSD > 0 ? volume24h / liquidityUSD : null

    const sellPressure =
      buys24h + sells24h > 0 ? sells24h / (buys24h + sells24h) : null

    // --------------------------------
    // NORMALIZED / WEIGHTED RISK SCORE
    // --------------------------------

    let score = 0
    const riskSignalSet = new Set()

    // Contract / control risks
    if (securityData.honeypot === true) {
      score += 40
      riskSignalSet.add("honeypot")
    }

    if (securityData.cannotSellAll === true) {
      score += 40
      riskSignalSet.add("cannotSellAll")
    }

    if (securityData.cannotBuy === true) {
      score += 25
      riskSignalSet.add("cannotBuy")
    }

    if (securityData.mintable === true) {
      score += 15
      riskSignalSet.add("mintable")
    }

    if (securityData.ownerRenounced === false) {
      score += 10
      riskSignalSet.add("ownerRenounced")
    }

    if (securityData.hiddenOwner === true) {
      score += 20
      riskSignalSet.add("hiddenOwner")
    }

    if (securityData.selfDestruct === true) {
      score += 20
      riskSignalSet.add("selfDestruct")
    }

    if (securityData.blacklist === true) {
      score += 10
      riskSignalSet.add("blacklist")
    }

    if (securityData.transferPausable === true) {
      score += 10
      riskSignalSet.add("transferPausable")
    }

    if (securityData.proxyContract === true) {
      score += 8
      riskSignalSet.add("proxyContract")
    }

    if (securityData.canTakeBackOwnership === true) {
      score += 15
      riskSignalSet.add("canTakeBackOwnership")
    }

    if ((securityData.sellTax ?? 0) > 10) {
      score += 10
      riskSignalSet.add("highSellTax")
    }

    // Liquidity / market structure risks
    if (liquidityUSD < 10000) {
      score += 20
      riskSignalSet.add("lowLiquidity")
    }

    if (liqRatio !== null) {
      if (liqRatio < 0.02) {
        score += 25
        riskSignalSet.add("extremeLiquidityRisk")
      } else if (liqRatio < 0.05) {
        score += 15
        riskSignalSet.add("lowLiquiditySupport")
      }
    }

    if (volRatio !== null && volRatio > 8) {
      score += 15
      riskSignalSet.add("washTradingSuspected")
    }

    // Whale concentration risks
    if ((holderData.topHolderPercent ?? 0) > 20) {
      score += 10
      riskSignalSet.add("highTopHolderConcentration")
    }

    if ((holderData.top5Percent ?? 0) > 40) {
      score += 25
      riskSignalSet.add("whaleConcentration")
    }

    if ((holderData.top10Percent ?? 0) > 60) {
      score += 30
      riskSignalSet.add("extremeWhaleControl")
    }

    // Optional behavioral hint
    if (sellPressure !== null && sellPressure > 0.75) {
      score += 10
      riskSignalSet.add("heavySellPressure")
    }

    const riskScore = clamp(Math.round(score), 0, 100)

    const riskLevel =
      riskScore >= 70 ? "High" :
      riskScore >= 40 ? "Moderate" :
      "Low"

    const securityGrade =
      riskScore >= 70 ? "F" :
      riskScore >= 50 ? "D" :
      riskScore >= 30 ? "C" :
      riskScore >= 15 ? "B" :
      "A"

    const riskSignals = Array.from(riskSignalSet)

    // --------------------------------
    // RESPONSE
    // --------------------------------

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

// --------------------------------------------------
// DexScreener
// smarter pair selection
// --------------------------------------------------
async function fetchDexScreener(contractAddress, chain) {
  try {
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`
    const dexRes = await fetch(dexUrl)
    const dexData = await dexRes.json()

    const pairs = dexData?.pairs || []
    const chainPairs = pairs.filter((p) => p.chainId === chain)

    const scoredPairs = (chainPairs.length ? chainPairs : pairs).map((p) => {
      const liquidity = safeNumber(p?.liquidity?.usd)
      const volume = safeNumber(p?.volume?.h24)
      const score = liquidity * 0.6 + volume * 0.4

      return {
        pair: p,
        score,
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

// --------------------------------------------------
// GoPlus
// --------------------------------------------------
async function fetchGoPlus(contractAddress, goplusChain) {
  if (!goplusChain) return null

  try {
    const goplusUrl =
      `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${contractAddress}`

    const goplusRes = await fetch(goplusUrl)
    const goplusJson = await goplusRes.json()

    const tokenSecurity =
      goplusJson?.result?.[contractAddress.toLowerCase()] || {}

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

// --------------------------------------------------
// Moralis holders
// --------------------------------------------------
async function fetchMoralisHolders(contractAddress, moralisChain) {
  if (!moralisChain || !process.env.MORALIS_API_KEY) return null

  try {
    const moralisUrl =
      `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=${moralisChain}&limit=10`

    const moralisRes = await fetch(moralisUrl, {
      headers: {
        "X-API-Key": process.env.MORALIS_API_KEY,
      },
    })

    const moralisJson = await moralisRes.json()
    const holders = moralisJson?.result || []

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

// --------------------------------------------------
// PulseChain RPC token metadata fallback
// --------------------------------------------------
async function fetchPulsechainTokenMetadata(contractAddress) {
  try {
    const [nameHex, symbolHex] = await Promise.all([
      rpcCall("eth_call", [
        { to: contractAddress, data: "0x06fdde03" },
        "latest",
      ]),
      rpcCall("eth_call", [
        { to: contractAddress, data: "0x95d89b41" },
        "latest",
      ]),
    ])

    return {
      name: decodeAbiString(nameHex),
      symbol: decodeAbiString(symbolHex),
    }
  } catch (e) {
    console.error("PulseChain RPC metadata error", e)
    return null
  }
}

// --------------------------------------------------
// PulseChain holder reconstruction
// --------------------------------------------------
async function fetchPulsechainHolderDistribution(contractAddress) {
  try {
    const latestBlockHex = await rpcCall("eth_blockNumber", [])
    const latestBlock = parseInt(latestBlockHex, 16)

    if (Number.isNaN(latestBlock)) return null

    let logs = null

    try {
      logs = await rpcCall("eth_getLogs", [
        {
          address: contractAddress,
          fromBlock: "0x0",
          toBlock: `0x${latestBlock.toString(16)}`,
          topics: [TRANSFER_TOPIC],
        },
      ])
    } catch {
      logs = await fetchPulsechainLogsChunked(contractAddress, latestBlock)
    }

    if (!Array.isArray(logs) || logs.length === 0) return null

    const balances = new Map()

    for (const log of logs) {
      const from = topicToAddress(log?.topics?.[1])
      const to = topicToAddress(log?.topics?.[2])
      const value = hexToBigInt(log?.data)

      if (value === 0n) continue

      if (from && from !== ZERO_ADDRESS) {
        const prev = balances.get(from) || 0n
        balances.set(from, prev - value)
      }

      if (to && to !== ZERO_ADDRESS) {
        const prev = balances.get(to) || 0n
        balances.set(to, prev + value)
      }
    }

    const positiveBalances = [...balances.entries()]
      .filter(([, bal]) => bal > 0n)
      .map(([address, balance]) => ({ address, balance }))

    if (!positiveBalances.length) return null

    let totalSupply = null

    try {
      const totalSupplyHex = await rpcCall("eth_call", [
        { to: contractAddress, data: "0x18160ddd" },
        "latest",
      ])
      totalSupply = hexToBigInt(totalSupplyHex)
    } catch {
      totalSupply = positiveBalances.reduce((sum, h) => sum + h.balance, 0n)
    }

    if (!totalSupply || totalSupply <= 0n) return null

    const holders = positiveBalances
      .map((h) => ({
        address: h.address,
        balance: h.balance,
        percentage: Number((h.balance * 10000n) / totalSupply) / 100,
      }))
      .sort((a, b) => b.percentage - a.percentage)

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
      holderCount: holders.length,
    }
  } catch (e) {
    console.error("PulseChain holder reconstruction error", e)
    return null
  }
}

// --------------------------------------------------
// Chunked PulseChain logs fallback
// --------------------------------------------------
async function fetchPulsechainLogsChunked(contractAddress, latestBlock) {
  const CHUNK_SIZE = 250000
  const MAX_CHUNKS = 40

  let from = 0
  let chunkCount = 0
  const allLogs = []

  while (from <= latestBlock && chunkCount < MAX_CHUNKS) {
    const to = Math.min(from + CHUNK_SIZE - 1, latestBlock)

    const chunkLogs = await rpcCall("eth_getLogs", [
      {
        address: contractAddress,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [TRANSFER_TOPIC],
      },
    ])

    if (Array.isArray(chunkLogs) && chunkLogs.length) {
      allLogs.push(...chunkLogs)
    }

    from = to + 1
    chunkCount += 1
  }

  return allLogs
}

// --------------------------------------------------
// Generic PulseChain RPC
// --------------------------------------------------
async function rpcCall(method, params) {
  const res = await fetch(PULSECHAIN_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  })

  const json = await res.json()

  if (json?.error) {
    throw new Error(json.error.message || "RPC error")
  }

  return json?.result
}

// --------------------------------------------------
// Cache helpers
// --------------------------------------------------
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

// --------------------------------------------------
// Utility helpers
// --------------------------------------------------
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
      const buf = Buffer.from(clean, "hex")
      const str = buf.toString("utf8").replace(/\0/g, "").trim()
      return str || null
    }

    if (clean.length >= 128) {
      const lenHex = clean.slice(64, 128)
      const len = parseInt(lenHex, 16)

      if (!Number.isNaN(len) && len > 0) {
        const dataHex = clean.slice(128, 128 + len * 2)
        const str = Buffer.from(dataHex, "hex")
          .toString("utf8")
          .replace(/\0/g, "")
          .trim()

        return str || null
      }
    }
  } catch {
    return null
  }

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