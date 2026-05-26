# WrappedBTC Reward Worker

This project automatically:

1. Claims Pump creator rewards from the dev wallet
2. Sends the configured treasury share of claimed SOL to a treasury wallet
3. Swaps the configured holder share from SOL into your chosen reward mint
4. Pays eligible holders using a share model of `1 share per full 500,000 tokens`
5. Saves a durable payout ledger so unfinished holder payouts resume before any new round starts

## What it uses

- Pump SDK for creator-fee claiming
- Jupiter quote/swap API for SOL -> reward token swaps
- Direct on-chain holder snapshots from your token mint

## Important defaults

- Poll interval: every 3 minutes
- Holder minimum: `500000` tokens
- Grandfather minimum: `250000` tokens for wallets frozen into `data/grandfathered.json`
- Split: configured by `HOLDER_REWARD_BPS` and `TREASURY_BPS`
- Dev wallet and treasury wallet are excluded from holder rewards by default
- Off-curve owners can be skipped to avoid paying PDAs and pool accounts
- Every payout round is snapshotted and persisted to `data/state.json`
- If any holder batch fails, the bot resumes those unpaid holders first on the next cycle

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env`

3. Fill in:

- `SOLANA_RPC_URLS`
- `PROJECT_NAME`
- `DEV_PRIVATE_KEY`
- `HOLDER_MINT`
- `REWARD_MINT`
- `TREASURY_ADDRESS`
- `JUPITER_API_KEY` (recommended for reliable Jupiter API access)
- `GRANDFATHER_FILE_PATH` if you want a custom snapshot location

4. Start in dry-run mode first:

```bash
npm run dev
```

5. When the logs look right, switch `DRY_RUN=false`

## Notes

- `REWARD_MINT` is explicit on purpose. There are multiple BTC wrappers on Solana, so the worker does not hardcode one.
- If no holders qualify in a cycle, the worker claims rewards and sends the treasury portion, but skips the swap/distribution.
- Share-weighted distribution uses floor division. Any tiny remainder stays in the sender reward ATA as dust and is logged.
- A holder who qualified in a stored round keeps that owed payout even if their balance changes later, because the payout ledger uses the original round snapshot.
- Grandfathered wallets can stay eligible with `250,000+` only if they were frozen into the snapshot file before the live rule went back to `500,000+`.
