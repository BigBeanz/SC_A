export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  try {

    const contractAddress = req.body?.contractAddress || req.body?.address

    if (!contractAddress) {
      return res.status(400).json({ error: "Missing contractAddress" })
    }

    const chainId = 1
    const chain = "eth"

    const bool = (val) => val === "1" ? true : val === "0" ? false : null
    const pct  = (val) => val !== undefined && val !== null ? parseFloat(val) : null

    async function fetchDexScreener(address) {
      try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`
        const r = await fetch(url)
        const data = await r.json()
        return data?.pairs?.[0] || null
      } catch {
        return null
      }
    }

    async function fetchGoPlus(address) {
      try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`
        const r = await fetch(url)
        const data = await r.json()
        return data?.result?.[address.toLowerCase()] || null
      } catch {
        return null
      }
    }

    async function fetchMoralis(address) {
      try {

        if (!process.env.MORALIS_API_KEY) return null

        const url = `https://deep-index.moralis.io/api/v2.2/erc20/${address}/owners?chain=${chain}&limit=10`

        const r = await fetch(url, {
          headers: {
            "X-API-Key": process.env.MORALIS_API_KEY
          }
        })

        const data = await r.json()

        return data?.result || null

      } catch {
        return null
      }
    }

    async function fetchContractAge(address) {

      try {

        if (!process.env.ETHERSCAN_API_KEY) return null

        const url = `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${process.env.ETHERSCAN_API_KEY}`

        const r = await fetch(url)
        const data = await r.json()

        const block = data?.result?.[0]?.blockNumber
        const timestamp = data?.result?.[0]?.timestamp

        if (!timestamp) return null

        const deployTime = Number(timestamp) * 1000
        const ageDays = (Date.now() - deployTime) / 86400000

        return Math.floor(ageDays)

      } catch {
        return null
      }
    }

    const [pair, goplus, moralis] = await Promise.all([
      fetchDexScreener(contractAddress),
      fetchGoPlus(contractAddress),
      fetchMoralis(contractAddress)
    ])

    const contractAgeDays = await fetchContractAge(contractAddress)

    const tokenName = pair?.baseToken?.name || "Unknown Token"
    const tokenSymbol = pair?.baseToken?.symbol || "UNKNOWN"

    const price = parseFloat(pair?.priceUsd || 0)
    const liquidityUSD = pair?.liquidity?.usd || 0
    const marketCap = pair?.fdv || 0
    const volume24h = pair?.volume?.h24 || 0

    const buys24h = pair?.txns?.h24?.buys || 0
    const sells24h = pair?.txns?.h24?.sells || 0
    const priceChange24h = pair?.priceChange?.h24 || 0

    const dexName = pair?.dexId || null
    const pairCreatedAt = pair?.pairCreatedAt || null

    const honeypot = bool(goplus?.is_honeypot)
    const mintable = bool(goplus?.is_mintable)
    const blacklist = bool(goplus?.is_blacklisted)
    const transferPausable = bool(goplus?.transfer_pausable)
    const proxyContract = bool(goplus?.is_proxy)
    const selfDestruct = bool(goplus?.selfdestruct)
    const hiddenOwner = bool(goplus?.hidden_owner)
    const canTakeBackOwnership = bool(goplus?.can_take_back_ownership)
    const slippageModifiable = bool(goplus?.slippage_modifiable)
    const tradingCooldown = bool(goplus?.trading_cooldown)
    const externalCall = bool(goplus?.external_call)
    const cannotBuy = bool(goplus?.cannot_buy)
    const cannotSellAll = bool(goplus?.cannot_sell_all)
    const isOpenSource = bool(goplus?.is_open_source)
    const ownerChangeBalance = bool(goplus?.owner_change_balance)
    const isWhitelisted = bool(goplus?.is_in_dex)

    const ownerAddress = goplus?.owner_address || null
    const creatorAddress = goplus?.creator_address || null

    const ownerRenounced = ownerAddress === "0x0000000000000000000000000000000000000000"

    const holderCount = goplus?.holder_count ? Number(goplus.holder_count) : null

    const buyTax = pct(goplus?.buy_tax)
    const sellTax = pct(goplus?.sell_tax)

    let topHolderPercent = null
    let top5Percent = null
    let top10Percent = null
    let whaleRisk = null

    if (moralis && moralis.length > 0) {

      topHolderPercent = moralis[0]?.percentage || null

      top5Percent = moralis.slice(0,5).reduce((sum,h)=>sum + (h.percentage || 0),0)
      top10Percent = moralis.slice(0,10).reduce((sum,h)=>sum + (h.percentage || 0),0)

      if (top10Percent > 60) whaleRisk = "High"
      else if (top10Percent > 40) whaleRisk = "Moderate"
      else whaleRisk = "Healthy"
    }

    let score = 0

    if (honeypot) score += 40
    if (mintable) score += 15
    if (!ownerRenounced) score += 10
    if (hiddenOwner) score += 20
    if (selfDestruct) score += 20
    if (blacklist) score += 10
    if (transferPausable) score += 10
    if (proxyContract) score += 8
    if (canTakeBackOwnership) score += 15
    if (sellTax > 10) score += 10
    if (liquidityUSD < 10000) score += 15
    if (topHolderPercent > 20) score += 10
    if (top10Percent > 50) score += 8

    const riskScore = Math.min(100, score)

    const riskLevel =
      riskScore >= 70 ? "High"
      : riskScore >= 40 ? "Moderate"
      : "Low"

    const securityGrade =
      riskScore >= 70 ? "F"
      : riskScore >= 50 ? "D"
      : riskScore >= 30 ? "C"
      : riskScore >= 15 ? "B"
      : "A"

    const riskSignals = []

    if (honeypot) riskSignals.push("Honeypot detected")
    if (mintable) riskSignals.push("Token is mintable")
    if (!ownerRenounced) riskSignals.push("Owner not renounced")
    if (hiddenOwner) riskSignals.push("Hidden owner detected")
    if (blacklist) riskSignals.push("Blacklist function present")
    if (transferPausable) riskSignals.push("Transfers can be paused")
    if (sellTax > 10) riskSignals.push("High sell tax")

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      address: contractAddress,

      price,
      liquidityUSD,
      marketCap,
      volume24h,

      buys24h,
      sells24h,
      priceChange24h,
      dexName,
      pairCreatedAt,

      riskScore,
      riskLevel,
      securityGrade,
      riskSignals,

      honeypot,
      mintable,
      blacklist,
      ownerRenounced,
      transferPausable,
      proxyContract,
      selfDestruct,
      hiddenOwner,
      canTakeBackOwnership,
      slippageModifiable,
      tradingCooldown,
      externalCall,
      cannotBuy,
      cannotSellAll,
      isOpenSource,
      ownerChangeBalance,
      isWhitelisted,

      buyTax,
      sellTax,

      ownerAddress,
      creatorAddress,

      holderCount,
      contractAgeDays,

      topHolderPercent,
      top5Percent,
      top10Percent,
      whaleRisk

    })

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })
  }
}