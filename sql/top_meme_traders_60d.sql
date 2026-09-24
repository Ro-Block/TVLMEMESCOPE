-- Top memecoin traders by realised ROI over the last 60 days (DuneSQL).
-- Save as a Dune query, schedule it (e.g. daily), then set DUNE_API_KEY and DUNE_QUERY_ID.
-- The app reads the latest cached result and uses it to seed the leaderboard until its own
-- trade ledger has enough history.
--
-- Output columns: chain, wallet, invested_usd, returned_usd, trades, tokens, wins, last_active
-- Open positions count as zero here (conservative); the app's own ledger marks them to market.
-- dex_solana.trades is very large, so run this on a medium/large engine.

WITH evm_quotes AS (
  SELECT * FROM (VALUES
    ('base', 0x4200000000000000000000000000000000000006), -- WETH
    ('base', 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913), -- USDC
    ('bnb',  0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c), -- WBNB
    ('bnb',  0x55d398326f99059ff775485246999027b3197955), -- USDT
    ('bnb',  0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d)  -- USDC
  ) AS q (chain, token)
),
sol_quotes AS (
  SELECT * FROM (VALUES
    'So11111111111111111111111111111111111111112',   -- wSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  -- USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'   -- USDT
  ) AS q (mint)
),
evm AS (
  SELECT
    t.blockchain AS chain,
    '0x' || lower(to_hex(t.tx_from)) AS wallet,
    CASE WHEN qs.token IS NOT NULL THEN '0x' || lower(to_hex(t.token_bought_address)) ELSE '0x' || lower(to_hex(t.token_sold_address)) END AS token,
    CASE WHEN qs.token IS NOT NULL THEN 'buy' ELSE 'sell' END AS side,
    t.amount_usd,
    t.block_time
  FROM dex.trades t
  LEFT JOIN evm_quotes qs ON qs.chain = t.blockchain AND qs.token = t.token_sold_address
  LEFT JOIN evm_quotes qb ON qb.chain = t.blockchain AND qb.token = t.token_bought_address
  WHERE t.blockchain IN ('base', 'bnb')
    AND t.block_time > now() - interval '60' day
    AND t.amount_usd > 0
    AND (qs.token IS NOT NULL) <> (qb.token IS NOT NULL) -- exactly one side is a quote token
),
sol AS (
  SELECT
    'solana' AS chain,
    t.trader_id AS wallet,
    CASE WHEN qs.mint IS NOT NULL THEN t.token_bought_mint_address ELSE t.token_sold_mint_address END AS token,
    CASE WHEN qs.mint IS NOT NULL THEN 'buy' ELSE 'sell' END AS side,
    t.amount_usd,
    t.block_time
  FROM dex_solana.trades t
  LEFT JOIN sol_quotes qs ON qs.mint = t.token_sold_mint_address
  LEFT JOIN sol_quotes qb ON qb.mint = t.token_bought_mint_address
  WHERE t.block_time > now() - interval '60' day
    AND t.amount_usd > 0
    AND (qs.mint IS NOT NULL) <> (qb.mint IS NOT NULL)
),
trades AS (
  SELECT * FROM evm
  UNION ALL
  SELECT * FROM sol
),
positions AS (
  SELECT
    chain, wallet, token,
    sum(CASE WHEN side = 'buy' THEN amount_usd ELSE 0 END) AS buy_usd,
    sum(CASE WHEN side = 'sell' THEN amount_usd ELSE 0 END) AS sell_usd,
    count(*) AS n,
    max(block_time) AS last_time
  FROM trades
  GROUP BY 1, 2, 3
  -- Only positions opened inside the window, so pre-window bags don't count as profit.
  HAVING sum(CASE WHEN side = 'buy' THEN amount_usd ELSE 0 END) > 0
)
SELECT
  chain,
  wallet,
  sum(buy_usd) AS invested_usd,
  sum(sell_usd) AS returned_usd,
  sum(n) AS trades,
  count(*) AS tokens,
  count_if(sell_usd > buy_usd) AS wins,
  max(last_time) AS last_active
FROM positions
GROUP BY 1, 2
HAVING count(*) >= 5                       -- sample size
   AND sum(buy_usd) >= 5000                -- real size
   AND sum(n) <= 25 * count(*)             -- not a volume/MEV bot
   AND sum(sell_usd) > sum(buy_usd)        -- profitable
ORDER BY sum(sell_usd) - sum(buy_usd) DESC
LIMIT 5000
