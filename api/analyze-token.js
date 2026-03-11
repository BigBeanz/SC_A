export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const { tokenAddress } = req.body

  if (!tokenAddress) {
    return res.status(400).json({ error: "Missing tokenAddress" })
  }

  return res.status(200).json({
    token: tokenAddress,
    price: "0.0000002272",
    liquidity: 9510.94,
    volume24h: 252,
    dex: "pulseX"
  })
}