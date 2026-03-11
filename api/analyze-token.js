export default async function handler(req, res) {

  // -----------------------------
  // CORS HEADERS
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
      return res.status(400).json({
        error: "Missing contract address"
      })
    }

    // -----------------------------
    // Fetch GoPlus Security Data
    // -----------------------------

    const goplus = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${address}`
    ).then(r => r.json())

    const security = goplus?.result?.[address] || {}

    // -----------------------------
    // Fetch DexScreener Market Data
    // -----------------------------

    const dex = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`
    ).then(r => r.json())

    const pair = dex?.pairs?.[0] || null

    // -----------------------------
    // Extract Security Signals
    // -----------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"

    const ownerRenounced =
      security.owner_address ===
      "0x0000000000000000000000000000000000000000"

    const buyTax = security.buy_tax || "0"
    const sellTax = security.sell_tax || "0"

    const liquidityUSD = pair?.liquidity?.usd || 0
    const marketCap = pair?.fdv || 0

    // -----------------------------
    // Risk Model
    // -----------------------------

    let riskScore = 100

    if (honeypot) riskScore -= 50
    if (mintable) riskScore -= 15
    if (blacklist) riskScore -= 20
    if (!ownerRenounced) riskScore -= 10
    if (Number(sellTax) > 10) riskScore -= 10

    if (riskScore < 0) riskScore = 0

    // -----------------------------
    // FINAL FLATTENED RESPONSE
    // -----------------------------

    const result = {

      tokenAddress: address,

      riskScore,

      honeypot,
      mintable,
      blacklist,
      ownerRenounced,

      buyTax,
      sellTax,

      liquidityUSD,
      marketCap,

      scanTime: new Date().toISOString()

    }

    res.status(200).json(result)

  } catch (error) {

    console.error(error)

    res.status(500).json({
      error: "Analyzer failed"
    })

  }
}