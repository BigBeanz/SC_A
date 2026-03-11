export default async function handler(req, res) {

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

    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

    // -----------------------------
    // Fetch APIs
    // -----------------------------

    const [goplusRes, dexRes, holderRes] = await Promise.all([

      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${normalizedAddress}`
      ),

      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${normalizedAddress}&page=1&offset=10&apikey=${ETHERSCAN_API_KEY}`
      )

    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()
    const holderData = await holderRes.json()

    const security = goplus?.result?.[normalizedAddress] || {}
    const pair = dex?.pairs?.[0] || {}

    const holders = holderData?.result || []

    // -----------------------------
    // Metadata
    // -----------------------------

    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      ""

    const liquidityUSD = Number(pair?.liquidity?.usd || 0)
    const marketCap = Number(pair?.fdv || 0)

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    const price = Number(pair?.priceUsd || 0)
    const volume24h = Number(pair?.volume?.h24 || 0)

    // -----------------------------
    // Security Flags
    // -----------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"
    const proxyContract = security.is_proxy === "1"

    const transferPausable =
      security.transfer_pausable === "1"

    const ownerAddress = security.owner_address || ""

    const ownerRenounced =
      ownerAddress ===
      "0x0000000000000000000000000000000000000000"

    // -----------------------------
    // Holder Distribution
    // -----------------------------

    let top10Percent = 0
    let whaleRisk = false

    if (holders.length > 0) {

      const totalSupply = holders.reduce(
        (sum, h) => sum + Number(h.TokenHolderQuantity),
        0
      )

      const top10Supply = holders.reduce(
        (sum, h) => sum + Number(h.TokenHolderQuantity),
        0
      )

      top10Percent = (top10Supply / totalSupply) * 100

      if (top10Percent > 60)
        whaleRisk = true
    }

    // -----------------------------
    // Risk Engine
    // -----------------------------

    let riskScore = 0
    const riskSignals = []

    const addRisk = (key, points, title, description) => {

      riskScore += points

      riskSignals.push({
        key,
        title,
        description,
        severity:
          points >= 30 ? "high" :
          points >= 15 ? "medium" :
          "low"
      })
    }

    if (honeypot)
      addRisk(
        "honeypot",
        80,
        "Honeypot detected",
        "Token may block selling."
      )

    if (mintable)
      addRisk(
        "mintable",
        20,
        "Mint function enabled",
        "Supply can be inflated."
      )

    if (blacklist)
      addRisk(
        "blacklist",
        30,
        "Blacklist capability",
        "Wallets may be blocked."
      )

    if (transferPausable)
      addRisk(
        "transferPause",
        20,
        "Transfers can be paused",
        "Trading may be frozen."
      )

    if (proxyContract)
      addRisk(
        "proxyContract",
        10,
        "Upgradeable proxy",
        "Logic may change."
      )

    if (!ownerRenounced)
      addRisk(
        "ownerActive",
        15,
        "Owner still active",
        "Developer retains control."
      )

    // Liquidity risk

    if (liquidityUSD < 25000)
      addRisk(
        "lowLiquidity",
        30,
        "Low liquidity",
        "Price manipulation possible."
      )

    // Whale concentration

    if (top10Percent > 60)
      addRisk(
        "whaleConcentration",
        40,
        "Whale concentration",
        "Top wallets control majority supply."
      )

    else if (top10Percent > 40)
      addRisk(
        "highWhaleConcentration",
        20,
        "High whale concentration",
        "Large holders may control price."
      )

    // Taxes

    if (sellTax > 20)
      addRisk(
        "extremeSellTax",
        40,
        "Extreme sell tax",
        "Selling heavily penalized."
      )

    else if (sellTax > 10)
      addRisk(
        "highSellTax",
        20,
        "High sell tax",
        "Selling expensive."
      )

    if (riskScore > 100)
      riskScore = 100

    // -----------------------------
    // Risk Level
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
    // Response
    // -----------------------------

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,

      riskScore,
      riskLevel,

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

      volume24h,
      price,

      holderMetrics: {
        top10Percent,
        whaleRisk
      },

      scanTime: new Date().toISOString()

    })

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}