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
    // RISK SCORE
    // --------------------------------

    let score = 0
    const riskSignalSet = new Set()

    // Contract risks

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

    // Liquidity risks

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

    // Whale concentration

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

    // --------------------------------
    // LAYER 2: MARKET HEALTH SIGNALS
    // --------------------------------

    if (priceChange24h !== null) {

      const drop = Math.abs(Math.min(0, priceChange24h))

      if (drop >= 50) {
        score += 30
        riskSignalSet.add("severeDropDetected")
      }
      else if (drop >= 25) {
        score += 18
        riskSignalSet.add("significantDropDetected")
      }
      else if (drop >= 15) {
        score += 8
        riskSignalSet.add("priceDropDetected")
      }

    }

    const contractAgeDays = pairCreatedAt
      ? (Date.now() - new Date(pairCreatedAt).getTime()) / 86400000
      : null

    if (contractAgeDays !== null) {

      if (contractAgeDays < 1) {
        score += 30
        riskSignalSet.add("veryNewToken")
      }
      else if (contractAgeDays < 7) {
        score += 20
        riskSignalSet.add("newToken")
      }
      else if (contractAgeDays < 30) {
        score += 8
        riskSignalSet.add("recentToken")
      }

    }

    if (contractAgeDays !== null && contractAgeDays < 7 && liquidityUSD < 50000) {

      score += 20
      riskSignalSet.add("newTokenLowLiquidity")

    }

    if (sellPressure !== null) {

      if (sellPressure > 0.75) {
        score += 20
        riskSignalSet.add("heavySellPressure")
      }
      else if (sellPressure > 0.65) {
        score += 10
        riskSignalSet.add("elevatedSellPressure")
      }

    }

    const marketActivityRatio =
      marketCap > 0 ? volume24h / marketCap : null

    if (marketActivityRatio !== null && marketActivityRatio < 0.001 && marketCap > 10000) {

      score += 12
      riskSignalSet.add("lowMarketActivity")

    }

    if (volume24h < 500 && marketCap > 5000) {

      score += 15
      riskSignalSet.add("inactiveToken")

    }

    const riskScore = clamp(Math.round(score), 0, 100)

    const riskLevel =
      riskScore >= 60 ? "High" :
      riskScore >= 30 ? "Moderate" :
      "Low"

    const securityGrade =
      riskScore >= 60 ? "F" :
      riskScore >= 45 ? "D" :
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
      error: "Analyzer failed"
    })

  }

}