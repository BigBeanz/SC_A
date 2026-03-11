export default async function handler(req, res) {

  // -----------------------------
  // CORS HEADERS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  // Handle browser preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  // Only allow POST
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
    // Example analysis logic
    // (replace with real scanning later)
    // -----------------------------
    const result = {
      tokenAddress: address,
      tokenName: "Sample Token",
      riskScore: 42,
      honeypot: false,
      liquidityLocked: true,
      ownerRenounced: true,
      holderConcentration: "Medium",
      scanTime: new Date().toISOString()
    }

    return res.status(200).json(result)

  } catch (error) {

    console.error(error)

    return res.status(500).json({
      error: "Internal server error"
    })
  }
}