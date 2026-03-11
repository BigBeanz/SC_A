import axios from "axios";

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { tokenAddress } = req.body;

  if (!tokenAddress) {
    return res.status(400).json({ error: "Token address required" });
  }

  try {

    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );

    const pair = response.data.pairs?.[0];

    if (!pair) {
      return res.status(404).json({ error: "Token not found" });
    }

    return res.status(200).json({
      token: tokenAddress,
      price: pair.priceUsd,
      liquidity: pair.liquidity?.usd,
      volume24h: pair.volume?.h24,
      buys: pair.txns?.h24?.buys,
      sells: pair.txns?.h24?.sells,
      dex: pair.dexId
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Token analysis failed"
    });

  }
}