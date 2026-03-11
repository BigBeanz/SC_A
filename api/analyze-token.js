export default async function handler(req, res) {

  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {

    const { address } = req.body

    if (!address) {
      return res.status(400).json({ error: "Missing contract address" })
    }

    const normalizedAddress = address.toLowerCase()

    // -----------------------------
    // Fetch Data
    // -----------------------------

    const [goplusRes, dexRes] = await Promise.all([
      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${normalizedAddress}`
      ),
      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      )
    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()

    const security = goplus?.result?.[normalizedAddress] || {}
    const pair = dex?.pairs?.[0] || {}

    // -----------------------------
    // Token Metadata
    // -----------------------------

    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      ""

    // -----------------------------
    // Market Data
    // -----------------------------

    const liquidityUSD = Number(pair?.liquidity?.usd || 0)
    const marketCap = Number(pair?.fdv || 0)

    const price = Number(pair?.priceUsd || 0)
    const volume24h = Number(pair?.volume?.h24 || 0)

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    // -----------------------------
    // Security Signals
    // -----------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"

    const transferPausable =
      security.transfer_pausable === "1" ||
      security.is_pausable === "1"

    const proxyContract = security.is_proxy === "1"

    const hiddenOwner = security.hidden_owner === "1"

    const ownerChangeBalance =
      security.owner_change_balance === "1"

    const ownerAddress = security.owner_address || ""

    const ownerRenounced =
      ownerAddress ===
      "0x0000000000000000000000000000000000000000"

    // -----------------------------
    // Risk Engine
    // -----------------------------

    let riskScore = 0
    const riskSignals = []

    const addRisk = (points, title, description) => {

      riskScore += points

      riskSignals.push({
        title,
        description,
        severity:
          points >= 30 ? "high" :
          points >= 15 ? "medium" :
          "low"
      })
    }

    // -----------------------------
    // Contract Risk
    // -----------------------------

    if (honeypot)
      addRisk(80, "Honeypot detected",
      "Selling may be restricted")

    if (hiddenOwner)
      addRisk(40, "Hidden owner",
      "Developer may retain hidden control")

    if (ownerChangeBalance)
      addRisk(35, "Owner can change balances",
      "Token balances may be manipulated")

    if (blacklist)
      addRisk(30, "Blacklist capability",
      "Wallets may be blocked from trading")

    if (mintable)
      addRisk(20, "Mint function enabled",
      "New tokens can be created")

    if (transferPausable)
      addRisk(20, "Transfers can be paused",
      "Trading may be frozen")

    if (proxyContract)
      addRisk(10, "Upgradeable proxy contract",
      "Contract logic may change")

    // -----------------------------
    // Tokenomics Risk
    // -----------------------------

    if (sellTax > 20)
      addRisk(40, "Extreme sell tax",
      "Selling may be very expensive")

    else if (sellTax > 10)
      addRisk(20, "High sell tax",
      "Selling costs are high")

    if (buyTax > 10)
      addRisk(10, "High buy tax",
      "Buying costs are elevated")

    // -----------------------------
    // Liquidity Risk
    // -----------------------------

    let liquidityRatio = 0

    if (marketCap > 0)
      liquidityRatio = liquidityUSD / marketCap

    if (liquidityUSD < 25000)
      addRisk(30, "Very low liquidity",
      "Liquidity pool is small")

    if (liquidityRatio < 0.01)
      addRisk(30, "Extremely low liquidity ratio",
      "Liquidity relative to market cap is very low")

    else if (liquidityRatio < 0.03)
      addRisk(15, "Low liquidity ratio",
      "Liquidity relative to market cap is limited")

    // -----------------------------
    // Dangerous Signal Patterns
    // -----------------------------

    if (mintable && !ownerRenounced)
      addRisk(25, "Mint rug risk",
      "Owner can mint unlimited tokens")

    if (proxyContract && !ownerRenounced)
      addRisk(20, "Upgradeable ownership risk",
      "Owner may upgrade contract logic")

    if (transferPausable && blacklist)
      addRisk(30, "Trading restriction risk",
      "Transfers or trading may be restricted")

    // -----------------------------
    // Cap Risk
    // -----------------------------

    if (riskScore > 100)
      riskScore = 100

    // -----------------------------
    // Risk Levels
    // -----------------------------

    let riskLevel = "Very Safe"

    if (riskScore >= 80)
      riskLevel = "Extreme Risk"

    else if (riskScore >= 60)
      riskLevel = "High Risk"

    else if (riskScore >= 40)
      riskLevel = "Moderate Risk"

    else if (riskScore >= 20)
      riskLevel = "Low Risk"

    // -----------------------------
    // Trade Safety Verdict
    // -----------------------------

    let tradeSafety = "Safe"

    if (riskScore > 70)
      tradeSafety = "Unsafe"

    else if (riskScore > 40)
      tradeSafety = "Caution"

    // -----------------------------
    // Response
    // -----------------------------

    const result = {

      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,

      riskScore,
      riskLevel,
      tradeSafety,

      riskSignals,

      honeypot,
      mintable,
      blacklist,
      ownerRenounced,
      transferPausable,
      proxyContract,

      buyTax,
      sellTax,

      liquidityUSD,
      marketCap,
      liquidityRatio,

      volume24h,
      price,

      scanTime: new Date().toISOString()

    }

    return res.status(200).json(result)

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }
}