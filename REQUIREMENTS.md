# Multi-Timeframe Reversal Scanner

## Project Overview
A real-time day trading dashboard for a small fund that monitors stocks across multiple timeframes for reversal signal confluence. The app automatically categorizes stocks by volatility and highlights strong setups where reversal signals align across all timeframes.

## Core Workflow
1. User uploads a **master list of stock tickers** (rolling 5-day watchlist, updated nightly)
2. App auto-calculates **ATR** for each stock and categorizes:
   - **Low Volatility**: ATR < 3
   - **High Volatility**: ATR >= 3
3. App monitors all stocks in **real-time** during market hours
4. Runs **reversal indicator logic** on each stock across **4 timeframes**:
   - Daily (1D)
   - 30-minute (30m)
   - 10-minute (10m)
   - 5-minute (5m)
5. Dashboard displays confluence grid highlighting strong setups
6. Sends **notifications** when all 4 timeframes align

## Reversal Indicator Logic (Converted from ThinkScript)

### Component 1: EMA Crossover System
- **3 Exponential Moving Averages**: 9-period (superfast), 14-period (fast), 21-period (slow)
- **Buy Signal**: EMA9 > EMA14 > EMA21 AND low > EMA9
- **Sell Signal**: EMA9 < EMA14 < EMA21 AND high < EMA9
- **Color Bars**:
  - Green (1) = Active buy signal
  - Red (2) = Active sell signal
  - Plum/Neutral (3) = No active signal

### Component 2: ZigZag Reversal Detection
- Uses ZigZag with ATR-based reversal amount (ATR length: 5, ATR reversal: 2.0)
- Tracks directional changes in price pivots
- **Bullish Reversal (U1)**: Signal crosses from <= 0 to > 0 (price low bouncing above ZigZag low)
- **Bearish Reversal (D1)**: Signal crosses from >= 0 to < 0 (price high dropping below ZigZag high)
- Reversal lines drawn at prior high/low levels

### Combined Signal
- A stock shows **bullish reversal** when U1 fires (ZigZag direction change upward)
- A stock shows **bearish reversal** when D1 fires (ZigZag direction change downward)
- EMA color bars provide trend context (green = bullish trend, red = bearish trend, plum = neutral)

## Dashboard Layout

### Section 1: Watchlist Management
- Upload/paste stock tickers (one master list)
- App auto-sorts into High/Low Volatility based on ATR
- Show current stock count per category
- Ability to add/remove individual tickers
- Rolling 5-day watchlist (updated nightly)

### Section 2: Confluence Scanner Grid
- **Columns**: Ticker | Price | ATR | Daily | 30m | 10m | 5m | Status
- **Cell Colors**:
  - Green = Bullish reversal signal active
  - Red = Bearish reversal signal active
  - Gray = No signal / Neutral
- **Row Highlighting**:
  - Strong bullish setup = All 4 timeframes green (highlighted row)
  - Strong bearish setup = All 4 timeframes red (highlighted row)
  - Partial setup = Mixed signals (normal row)
- **Grouping**: Stocks grouped by volatility category (High / Low)
- **Sorting**: Strong setups (full confluence) float to the top

### Section 3: Notifications
- Browser notifications when a new 4-timeframe confluence appears
- Sound alert for strong setups
- Notification log/history

## Tech Stack

### Frontend
- **React** with Vite
- **TailwindCSS** for styling
- **TypeScript**
- Real-time updates via polling or WebSockets

### Backend
- **Azure Functions** (Node.js / TypeScript)
- REST API endpoints for:
  - Watchlist CRUD
  - Stock data fetching
  - Reversal signal computation

### Data Source
- **Polygon.io API** for real-time and historical market data
- Endpoints needed:
  - Aggregates (candles) for multiple timeframes
  - Snapshot for current prices
  - ATR calculation from daily candles

### Deployment
- **Azure Static Web Apps** (frontend + API)
- Deploy via `swa deploy` CLI
- Database: Azure Table Storage or Cosmos DB (free tier) for watchlists

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/watchlist` | Get all watchlist stocks with categories |
| POST | `/api/watchlist` | Upload/add stock tickers |
| DELETE | `/api/watchlist/:ticker` | Remove a stock |
| GET | `/api/scan` | Run reversal scan on all watchlist stocks |
| GET | `/api/scan/:ticker` | Get reversal signals for a specific stock |
| GET | `/api/health` | Health check |

## Future Enhancements (Phase 2+)
- Automated watchlist import from Thinkorswim
- Trade journal integration
- Position sizing calculator
- Historical backtest of reversal signals
- Mobile responsive / PWA
- Schwab API integration for live account data

## Original ThinkScript Source
The reversal indicator ThinkScript code is preserved in `docs/thinkscript-original.tos` for reference.
