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

    if (!address)
      return res.status(400).json({ error: "Missing contract address" })

    const normalizedAddress = address.toLowerCase()

    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY

    const [goplusRes, dexRes, creationRes] = await Promise.all([

      fetch(
        `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${normalizedAddress}`
      ),

      fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${normalizedAddress}`
      ),

      fetch(
        `https://api.etherscan.io/api?module=contract&action=getcontractcreation&contractaddresses=${normalizedAddress}&apikey=${ETHERSCAN_API_KEY}`
      )

    ])

    const goplus = await goplusRes.json()
    const dex = await dexRes.json()
    const creation = await creationRes.json()

    const security = goplus?.result?.[normalizedAddress] || {}
    const pair = dex?.pairs?.[0] || {}

    const tokenName =
      pair?.baseToken?.name ||
      security.token_name ||
      "Unknown Token"

    const tokenSymbol =
      pair?.baseToken?.symbol ||
      ""

    const liquidityUSD = Number(pair?.liquidity?.usd || 0)
    const marketCap = Number(pair?.fdv || 0)
    const price = Number(pair?.priceUsd || 0)
    const volume24h = Number(pair?.volume?.h24 || 0)

    const pairCreatedAt =
      pair?.pairCreatedAt
        ? new Date(pair.pairCreatedAt).toISOString()
        : null

    let contractAgeDays = null

    if (creation?.result?.length > 0) {

      const txHash = creation.result[0].txHash

      const txRes = await fetch(
        `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`
      )

      const tx = await txRes.json()
      const blockNumber = tx?.result?.blockNumber

      if (blockNumber) {

        const blockRes = await fetch(
          `https://api.etherscan.io/api?module=proxy&action=eth_getBlockByNumber&tag=${blockNumber}&boolean=true&apikey=${ETHERSCAN_API_KEY}`
        )

        const block = await blockRes.json()
        const timestampHex = block?.result?.timestamp

        if (timestampHex) {

          const timestamp = parseInt(timestampHex, 16) * 1000
          contractAgeDays = (Date.now() - timestamp) / 86400000

        }

      }

    }

    const buyTax = Number(security.buy_tax || 0)
    const sellTax = Number(security.sell_tax || 0)

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const proxyContract = security.is_proxy === "1"
    const transferPausable = security.transfer_pausable === "1"

    const ownerAddress = security.owner_address || ""

    const ownerRenounced =
      ownerAddress ===
      "0x0000000000000000000000000000000000000000"

    // --------------------------------------------------
    // Liquidity Lock Detection
    // --------------------------------------------------

    let liquidityLocked = false
    let liquidityLockType = "unknown"
    let lpHolder = null

    const burnAddress = "0x000000000000000000000000000000000000dead"

    if (pair?.pairAddress) {

      const lpToken = pair.pairAddress

      const holderRes = await fetch(
        `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${lpToken}&page=1&offset=5&apikey=${ETHERSCAN_API_KEY}`
      )

      const holders = await holderRes.json()

      const topHolder = holders?.result?.[0]?.TokenHolderAddress

      lpHolder = topHolder

      if (topHolder?.toLowerCase() === burnAddress) {

        liquidityLocked = true
        liquidityLockType = "burned"

      }

    }

    // --------------------------------------------------
    // Risk Engine
    // --------------------------------------------------

    let riskScore = 0
    const riskSignals = []

    const addRisk = (key, points, title, description) => {

      riskScore += points

      riskSignals.push({
        key,
        title,
        description
      })

    }

    if (honeypot && sellTax > 20)
      addRisk(
        "honeypot",
        80,
        "Possible honeypot",
        "Security scanner detected honeypot behavior."
      )

    else if (honeypot)
      addRisk(
        "honeypotWarning",
        25,
        "Honeypot warning",
        "Security API flagged possible honeypot behavior."
      )

    if (mintable)
      addRisk(
        "mintable",
        15,
        "Mint function enabled",
        "New tokens can be created."
      )

    if (!ownerRenounced)
      addRisk(
        "ownerActive",
        10,
        "Owner still active",
        "Developer retains control."
      )

    if (!liquidityLocked)
      addRisk(
        "liquidityUnlocked",
        25,
        "Liquidity not locked",
        "Developer may be able to remove liquidity."
      )

    if (riskScore > 100)
      riskScore = 100

    let riskLevel = "Low Risk"

    if (riskScore >= 80)
      riskLevel = "Extreme Risk"
    else if (riskScore >= 60)
      riskLevel = "High Risk"
    else if (riskScore >= 40)
      riskLevel = "Moderate Risk"

    return res.status(200).json({

      tokenName,
      tokenSymbol,
      tokenAddress: normalizedAddress,

      riskScore,
      riskLevel,

      contractAgeDays,
      pairCreatedAt,

      liquidityLocked,
      liquidityLockType,
      lpHolder,

      honeypot,
      mintable,
      ownerRenounced,
      proxyContract,
      transferPausable,

      buyTax,
      sellTax,

      liquidityUSD,
      marketCap,
      volume24h,
      price,

      riskSignals,

      scanTime: new Date().toISOString()

    })

  } catch (error) {

    console.error("Analyzer error:", error)

    return res.status(500).json({
      error: "Analyzer failed"
    })

  }

}