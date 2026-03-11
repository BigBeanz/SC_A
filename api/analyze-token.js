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

    // -------------------------
    // Fetch security data
    // -------------------------

    const goplus = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${address}`
    ).then(r => r.json())

    const dex = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`
    ).then(r => r.json())

    const security = goplus.result[address] || {}

    const pair = dex.pairs ? dex.pairs[0] : null

    // -------------------------
    // Extract important signals
    // -------------------------

    const honeypot = security.is_honeypot === "1"
    const mintable = security.is_mintable === "1"
    const blacklist = security.is_blacklisted === "1"
    const ownerRenounced = security.owner_address === "0x0000000000000000000000000000000000000000"

    const buyTax = security.buy_tax || "0"
    const sellTax = security.sell_tax || "0"

    const liquidity = pair?.liquidity?.usd || 0
    const marketCap = pair?.fdv || 0

    // -------------------------
    // Risk scoring model
    // -------------------------

    let risk = 100

    if (honeypot) risk -= 50
    if (mintable) risk -= 15
    if (blacklist) risk -= 20
    if (!ownerRenounced) risk -= 10
    if (sellTax > 10) risk -= 10

    if (risk < 0) risk = 0

    // -------------------------
    // Final response
    // -------------------------

    const result = {

      tokenAddress: address,

      riskScore: risk,

      security: {
        honeypot,
        mintable,
        blacklist,
        ownerRenounced
      },

      tokenomics: {
        buyTax,
        sellTax
      },

      market: {
        liquidityUSD: liquidity,
        marketCap
      },

      scanTime: new Date().toISOString()

    }

    res.status(200).json(result)

  } catch (err) {

    console.error(err)

    res.status(500).json({
      error: "Analyzer failed"
    })

  }

}