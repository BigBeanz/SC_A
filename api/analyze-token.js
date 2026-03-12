export default async function handler(req, res) {

  // --------------------------------
  // CORS
  // --------------------------------

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

    // --------------------------------
    // DexScreener Fetch
    // --------------------------------

    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`

    const dexRes = await fetch(dexUrl)
    const dexData = await dexRes.json()

    const pairs = dexData?.pairs || []

    // --------------------------------
    // Select correct chain pairs
    // --------------------------------

    const chainPairs = pairs.filter(p => p.chainId === chain)

    // --------------------------------
    // Select highest liquidity pair
    // --------------------------------

    const pair =
      chainPairs.sort(
        (a,b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)
      )[0] ||
      pairs[0]

    // --------------------------------
    // Market Data
    // --------------------------------

    const tokenName = pair?.baseToken?.name || "Unknown Token"
    const tokenSymbol = pair?.baseToken?.symbol || "UNKNOWN"

    const price = parseFloat(pair?.priceUsd || 0)
    const liquidityUSD = parseFloat(pair?.liquidity?.usd || 0)
    const marketCap = parseFloat(pair?.fdv || 0)
    const volume24h = parseFloat(pair?.volume?.h24 || 0)

    const buys24h = pair?.txns?.h24?.buys || 0
    const sells24h = pair?.txns?.h24?.sells || 0

    const dexName = pair?.dexId || "unknown"

    // --------------------------------
    // New Fields Requested
    // --------------------------------

    const pairCreatedAt = pair?.pairCreatedAt || null
    const priceChange24h = pair?.priceChange?.h24 || null
    const fdv = parseFloat(pair?.fdv || 0)
    const scanTime = new Date().toISOString()

    // --------------------------------
    // Chain map for APIs
    // --------------------------------

    const chainMap = {
      ethereum: { moralis: "eth", goplus: "1" },
      bsc: { moralis: "bsc", goplus: "56" },
      polygon: { moralis: "polygon", goplus: "137" },
      arbitrum: { moralis: "arbitrum", goplus: "42161" }
    }

    const moralisChain = chainMap[chain]?.moralis || null
    const goplusChain = chainMap[chain]?.goplus || null

    // --------------------------------
    // GoPlus Security
    // --------------------------------

    let securityData = {}

    if (goplusChain) {

      try {

        const goplusUrl =
          `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${contractAddress}`

        const goplusRes = await fetch(goplusUrl)
        const goplusJson = await goplusRes.json()

        const tokenSecurity =
          goplusJson?.result?.[contractAddress.toLowerCase()] || {}

        const bool = (v) => v === "1"
        const pct = (v) => v ? parseFloat(v) : 0

        securityData = {

          honeypot: bool(tokenSecurity.is_honeypot),
          mintable: bool(tokenSecurity.is_mintable),
          blacklist: bool(tokenSecurity.is_blacklisted),

          ownerRenounced:
            tokenSecurity.owner_address ===
            "0x0000000000000000000000000000000000000000",

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

          ownerAddress: tokenSecurity.owner_address || null,
          creatorAddress: tokenSecurity.creator_address || null,

          holderCount: parseInt(tokenSecurity.holder_count || 0),

          isOpenSource: bool(tokenSecurity.is_open_source),
          ownerChangeBalance: bool(tokenSecurity.owner_change_balance),
          isWhitelisted: bool(tokenSecurity.is_in_dex)

        }

      } catch (e) {

        console.error("GoPlus error", e)

      }

    }

    // --------------------------------
    // Moralis Holder Distribution
    // --------------------------------

    let holderData = {
      topHolderPercent: null,
      top5Percent: null,
      top10Percent: null,
      whaleRisk: null
    }

    if (moralisChain && process.env.MORALIS_API_KEY) {

      try {

        const moralisUrl =
          `https://deep-index.moralis.io/api/v2.2/erc20/${contractAddress}/owners?chain=${moralisChain}&limit=10`

        const moralisRes = await fetch(moralisUrl, {
          headers: {
            "X-API-Key": process.env.MORALIS_API_KEY
          }
        })

        const moralisJson = await moralisRes.json()

        const holders = moralisJson?.result || []

        if (holders.length) {

          const topHolderPercent = holders[0]?.percentage || 0

          const top5Percent =
            holders.slice(0,5)
              .reduce((sum,h)=>sum+(h.percentage||0),0)

          const top10Percent =
            holders.slice(0,10)
              .reduce((sum,h)=>sum+(h.percentage||0),0)

          let whaleRisk = "Healthy"

          if (top10Percent > 60) whaleRisk = "High"
          else if (top10Percent > 40) whaleRisk = "Moderate"

          holderData = {
            topHolderPercent,
            top5Percent,
            top10Percent,
            whaleRisk
          }

        }

      } catch (e) {

        console.error("Moralis error", e)

      }

    }

    // --------------------------------
    // Risk Score
    // --------------------------------

    let score = 0

    if (securityData.honeypot) score += 40
    if (securityData.mintable) score += 15
    if (!securityData.ownerRenounced) score += 10
    if (securityData.hiddenOwner) score += 20
    if (securityData.selfDestruct) score += 20
    if (securityData.blacklist) score += 10
    if (securityData.transferPausable) score += 10
    if (securityData.proxyContract) score += 8
    if (securityData.canTakeBackOwnership) score += 15
    if (securityData.sellTax > 10) score += 10
    if (liquidityUSD < 10000) score += 15
    if (holderData.topHolderPercent > 20) score += 10
    if (holderData.top10Percent > 50) score += 8

    const riskScore = Math.min(100, score)

    const riskLevel =
      score >= 70 ? "High"
      : score >= 40 ? "Moderate"
      : "Low"

    const securityGrade =
      score >= 70 ? "F"
      : score >= 50 ? "D"
      : score >= 30 ? "C"
      : score >= 15 ? "B"
      : "A"

    // --------------------------------
    // Risk Signals (New)
    // --------------------------------

    const riskSignals = []

    if (securityData.honeypot) riskSignals.push("honeypot")
    if (securityData.mintable) riskSignals.push("mintable")
    if (!securityData.ownerRenounced) riskSignals.push("ownerRenounced")
    if (securityData.hiddenOwner) riskSignals.push("hiddenOwner")
    if (securityData.selfDestruct) riskSignals.push("selfDestruct")
    if (securityData.blacklist) riskSignals.push("blacklist")
    if (securityData.transferPausable) riskSignals.push("transferPausable")
    if (securityData.proxyContract) riskSignals.push("proxyContract")
    if (securityData.canTakeBackOwnership) riskSignals.push("canTakeBackOwnership")
    if (securityData.sellTax > 10) riskSignals.push("highSellTax")
    if (liquidityUSD < 10000) riskSignals.push("lowLiquidity")

    // --------------------------------
    // Response
    // --------------------------------

    return res.status(200).json({

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
      dexName,

      pairCreatedAt,
      priceChange24h,
      fdv,
      scanTime,

      riskScore,
      riskLevel,
      securityGrade,
      riskSignals,

      ...securityData,
      ...holderData

    })

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}