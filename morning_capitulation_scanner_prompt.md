# Claude Code Prompt: Morning Capitulation Scanner

---

## Overview

Build a **production-ready Python scanner** called `capitulation_scanner.py` that monitors a curated watchlist of 1,105 stocks every market morning and detects **gap-down + recovery** setups (morning capitulation followed by intraday absorption). When qualifying signals are found, they are tiered by urgency and **push alerts are sent to a phone via Pushover**.

---

## Core Signal Logic

A stock qualifies when **both conditions are true simultaneously**:

1. **Gap Down from prior close** — the stock opened significantly lower than yesterday's close
2. **Positive Change from Open** — despite the gap down, current price is *above* the opening price (buyers absorbing the sell-off)

This two-phase signal means: *the flush happened, now watch for the squeeze.*

---

## Signal Tiers

Classify every qualifying signal into one of three tiers based on gap size, recovery strength, and relative volume:

### 🔴 CRITICAL
- Gap down ≥ 8% from prior close
- Change from open ≥ +1.0%
- Relative Volume (RVOL) ≥ 3.0x (current volume vs 20-day average volume for this time of day)
- Alert immediately — do not wait for next scan cycle

### 🟠 HIGH
- Gap down ≥ 5% from prior close
- Change from open ≥ +0.5%
- RVOL ≥ 2.0x

### 🟡 WATCH
- Gap down ≥ 3% from prior close
- Any positive change from open (> 0%)
- RVOL ≥ 1.5x

> If a stock meets multiple tiers, assign the highest applicable tier.

---

## Time-of-Day Weighting

Recovery speed matters. Apply a **time weight multiplier** to the urgency score:

| Time Window (ET) | Multiplier | Reason |
|---|---|---|
| 09:30 – 10:00 | 2.0x | First 30 min: highest significance |
| 10:00 – 10:30 | 1.5x | Still early, meaningful |
| 10:30 – 11:30 | 1.2x | Moderate significance |
| 11:30 – 14:00 | 1.0x | Standard weight |
| 14:00 – 16:00 | 0.8x | Late recovery, lower conviction |

This multiplier should be displayed alongside the signal but does not change the tier classification — it's informational for the trader.

---

## Polygon API Integration

Use the **Polygon.io REST API** with the user's paid access key.

### Required endpoints:

**1. Previous Day Close** — to compute gap %
```
GET https://api.polygon.io/v2/aggs/ticker/{ticker}/prev?adjusted=true&apiKey={KEY}
```
Returns: `c` (close price), `v` (volume)

**2. Current Day Open + Current Price** — intraday snapshot
```
GET https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}?apiKey={KEY}
```
Returns snapshot including:
- `day.o` — today's open
- `lastTrade.p` — current price (or `min.c` for latest minute close)
- `day.v` — today's volume so far
- `prevDay.c` — prior close (alternative source)

**3. Average Daily Volume** — for RVOL calculation
```
GET https://api.polygon.io/v2/aggs/ticker/{ticker}/range/1/day/{from_date}/{to_date}?adjusted=true&limit=22&apiKey={KEY}
```
Use the last 20 trading days to calculate average daily volume. For intraday RVOL, normalize: `rvol = (today_volume_so_far / avg_daily_volume) * (390 / minutes_elapsed_today)`

### Batching Strategy (important for 1,105 tickers):
- Use `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers={comma_list}&apiKey={KEY}` to batch up to 250 tickers per request
- Split 1,105 tickers into batches of 250 and fire requests concurrently using `asyncio` + `aiohttp`
- Implement exponential backoff on rate limit errors (HTTP 429)
- Cache previous-close and average volume data at startup; only refresh snapshots on each scan cycle

---

## Watchlist

The scanner monitors exactly these 1,105 tickers (loaded from `tickers.py` or hardcoded in a `WATCHLIST` constant):

```
BDSX,BNAI,AMPX,IREZ,IOT,CAPR,UMAC,PLTU,PTIR,UVXY,BEAM,AVAV,VKTX,RNG,NSP,OKLS,RKLX,EKSO,BMNZ,PL,MRVL,SOC,NTLA,VXX,SRPT,TERN,BA,TTAN,VIXY,RCAT,SNDX,VOR,VELO,INOD,PGNY,QBTX,ALKT,DDOG,PLTR,MDB,KTOS,CART,DOCN,SFM,PCVX,VRNS,SLNO,ROKU,EPAM,IMNM,PAVM,SOXS,LQDA,APGE,EYPT,LMND,CDE,WAL,ACHC,RGLD,CROX,KR,SNOW,CF,PAYX,CNXC,BR,FFIV,BOIL,CGON,GWRE,CENX,BRBR,GLUE,USO,COST,NOW,EWY,WDAY,INTU,FOXA,BG,RKLB,VERA,SHNY,CCOI,PSTG,RTX,RCL,FIS,BWXT,NET,ETHD,TGTX,TWLO,EXPE,KMX,NTRA,ACM,ELVN,DFTX,MAN,DOX,PPLC,BAH,CAVA,DRS,EXEL,HRB,ECH,RBRK,AGQ,ADP,INDV,KYMR,AWK,TVTX,SHLD,RGTI,SKYT,AA,NEM,ALB,IMVT,TEAM,SOFI,GDXJ,NVDQ,PPTA,LBRDK,GDX,SBIT,CTRI,MP,FOX,ALAB,CBZ,SBUX,QBTS,EXPD,MDLN,IONX,BNO,UGL,ZETA,BBY,DELL,LHX,CORT,HNGE,XBI,GGLL,APG,PINS,CTSH,EXC,ESTC,KRMN,ETSY,DUOL,MCO,ZS,VRSK,CHD,DLTR,BRO,NDAQ,PANW,SUNB,LPTH,ARQT,VLTO,ALGN,MPC,BTSG,TRMB,GIS,LLY,COGT,SSNC,YUM,CLX,KMB,CL,LMT,CIBR,DTE,ELF,MSTZ,AXON,BMRN,BBIO,CHTR,EFX,FEZ,AMGN,SILJ,HUBS,EZU,SCHW,MLYS,TWST,XMTR,GDDY,LW,ULS,EQH,GBCI,TGT,ZM,OKTA,EIX,GH,LUNR,TNGX,AVGX,PEGA,IEUR,YINN,ICE,HIMS,LDOS,C,ES,EVRG,BILL,NXT,VGK,MISL,SIL,EWZ,APO,CALM,TECS,IGV,SLVP,ADBE,ZBH,PSA,DNLI,BITI,WYFI,ED,SIVR,REMX,QCOM,SLV,ROL,SPGI,PNW,PWR,JPM,ELV,EFV,CMS,MTB,ZION,IEFA,WMT,CDW,AUB,WBS,EFA,DOCU,FSLY,CWEN,ASO,SNPS,XLP,LRN,INSP,FIBK,VEA,UDOW,IAUM,WELL,MTDR,SGOL,PB,BAR,AAAU,GLD,CCI,SEI,ENOV,GLDM,EMXC,IBM,NTAP,IAU,OUNZ,FNGU,VIRT,TOST,XEL,BW,ALNY,RCUS,D,GD,AFL,IONQ,IDEV,VEU,RHI,DG,CFG,FIGR,EEM,ESGE,HALO,SRRK,FNF,IXUS,EXLS,DUK,WRB,LKQ,VOYG,ACWX,CAH,GOOGL,IRDM,SCZ,AVDE,VPL,UCO,PSN,LAUR,PLTM,HXL,VYMI,DE,VTR,TEM,PFG,GOOG,ADM,DYN,MET,IEMG,PPLT,TAP,AGIO,CTVA,OKE,CRWD,TSLQ,LNT,MHK,DKNG,AFRM,AEP,CDNS,PNFP,AVGO,INTA,PRCT,GS,SRTY,CRM,PTCT,LNG,IBB,MDLZ,BBJP,GM,VXUS,OII,WWW,PM,AEE,KBR,O,IBKR,CNC,PZZA,MRNA,TDS,HIG,KVYO,MCHI,NOG,VITL,SWK,TMUS,CRNX,ACAD,MCD,UBER,VRDN,LOW,BSY,OUST,MA,NEE,AVEM,VEEV,TTC,TRV,PEP,HL,AIQ,ALL,ROP,ADC,UPS,EQR,TTWO,MS,MAS,GPC,EWJ,VSNT,KRE,SN,GRAL,VSAT,CZR,LIF,TMHC,WPC,SPXU,UNM,JNJ,ENPH,V,KBE,SPXS,WM,SJM,OC,HAS,OMC,FISV,FWONK,TENB,CME,TXN,ALGM,AXTA,AMT,DT,DAWN,HCA,ARKK,ZTS,AHR,SYY,DVA,ATO,VRT,DIA,SARO,KO,ACWI,SDS,TTD,NN,RYAN,GILD,PRIM,FTV,POR,VIG,RVMD,BK,VYM,SQQQ,WEC,KBWB,CQQQ,SPMO,ETR,XLC,WFC,BAC,FLR,VT,FIVN,MRK,FSLR,SRE,BL,CSCO,HWM,DIS,ARKG,CBSH,SO,CPRT,TW,TAN,AXP,HD,XLI,XYZ,PHM,IONS,RSG,COR,HASI,VNOM,REG,VZ,CRWV,VONG,KBH,CSGP,W,ORCL,UAL,FAST,AOS,EWW,TRU,IT,ACLX,KIE,AVB,URA,OXY,PG,EBAY,BAM,DKS,IUSV,LEU,STZ,ISRG,BKSY,MASI,RARE,TOL,PGR,IWF,SPHQ,XLV,MSFT,Z,PCOR,AJG,COLB,CRBG,EA,QQQM,AKAM,SHOO,OZK,QQQ,QDEL,VUG,RMBS,MSFU,ORLY,HON,UPST,ABBV,SF,CWVX,RMD,RVLV,BRK-B,CC,TSN,SPYG,IWD,VRTX,PRU,SPYM,CELH,PEG,VTV,MIR,VOO,RSP,IWB,VTI,IVV,SPY,COF,NBIX,IVW,ITOT,VONV,GE,CCL,HP,QLD,WMG,AMTM,ADSK,CIEN,URBN,TJX,QUAL,FLUT,EHC,CAT,TXT,BMY,BKR,IWM,VNQ,TQQQ,ELS,MPLX,CLMT,ECL,DRI,COIN,HSY,ARE,VTWO,NVOX,SHW,CBRE,LNC,GPCR,XLY,TROW,FORM,UNH,APPN,INCY,CHRW,NFLX,MXL,IWR,IYR,SSO,IYW,XME,DD,MAA,TSLA,VLUE,FTNT,XLK,MNST,PSX,SSRM,CUBE,MKC,SON,ZG,SMCI,EMR,PYPL,IVZ,XRT,STAA,UPRO,SYF,USB,SCI,ALMS,SPXL,ABNB,SCCO,AAPL,KD,MMM,BWA,CAKE,META,GEV,ATI,IJR,KNTK,FIVE,CVX,ALK,EXR,EQT,BOX,PAYC,DAL,ITT,OPCH,TTEK,EWT,NCLH,SYK,USFD,MO,MAR,COO,DASH,ROST,OMF,RDVY,AME,SPYU,APA,BLDR,FNGD,COPX,CTAS,GMED,MAGS,TSCO,MRSH,TSLL,BDX,APLS,DAR,MDY,IJH,FITB,NTNX,SM,RJF,EMN,NUE,BIIB,SMCX,CRK,PNC,XYL,BAI,TREX,WLK,TSLR,SPMD,NKE,URTY,XHB,AAPU,MSTY,IYE,VVV,ITB,STEP,AMZN,IRM,SOLV,METU,TPR,CARG,TNA,FTAI,POWI,PCAR,DINO,NFXL,CRCL,XLB,DHI,TSLT,IE,CRVS,PLD,EWTX,FROG,ST,LAZ,OTIS,PTC,PGY,SDOW,PAVE,FBL,APP,NTRS,XOP,BJ,APH,MSI,OLLI,STX,SATS,HAL,CORD,GFS,NYT,TXG,CALX,DVN,VNT,MSTR,XLE,EAT,CPT,CVNA,EXE,VLO,EL,ABT,EOG,NCNO,DAN,AROC,HOOD,MTCH,GPN,CVS,FAZ,QRVO,CGNX,AAP,RPM,ADNT,FANG,SWKS,SMH,OLMA,ADI,GTLB,STT,DXYZ,WMB,MC,WSM,MOS,IAC,AAON,CNK,AIG,RBLX,NVDA,BULZ,FOUR,TECL,WYNN,CARR,CRCA,LINE,ARMK,FLY,BITB,SGI,FBTC,IBIT,HUM,GBTC,YANG,XOM,ARKB,CHWY,ITW,BTC,SMR,LTH,YETI,A,TPG,PFGC,CMC,SLG,OVV,COP,RAL,MCHP,AMAT,PLNT,AMD,BX,CRH,RUN,APD,SOXX,BALL,APPX,ANF,LBRT,ETH,FR,MUR,SLM,FETH,HLT,COHR,DOV,CYTK,ETHA,PAR,JBL,LVS,ETHW,FDX,WH,EW,TECH,ETHE,FRPT,INFQ,ILMN,NSC,FIG,NKTR,TFC,Q,SLB,FTI,DLR,PACS,AEO,AMZU,TMO,U,PRKS,WES,KKR,WDC,INSM,CAI,CVI,LYV,YOU,GEHC,NVST,FERG,LPX,CCK,ALLY,AR,LEN,RDDT,ROBN,LENZ,QXO,FLEX,CWST,SMTC,KLAC,IQV,PLAB,METC,MIAX,BTU,HSIC,FCX,ACMR,SPG,BSX,KRC,RBA,AVT,UNP,DGX,RRC,DHR,ASTS,CBRL,TDC,STLD,MGM,BRZE,NVDX,RKT,FND,DXCM,VMC,IR,NVDL,BTGO,CHYM,BF-B,GUSH,AAOI,WAY,LASR,UEC,DECK,TEX,CEG,ANET,ZSL,MU,CNM,WHR,BITX,TRGP,KGS,BITU,DOCS,AMDL,ON,INTC,PARR,NRG,BBNX,NE,IP,ARES,RNA,PPG,KEYS,LRCX,EYE,ARWR,IFF,WSC,SVXY,ETHU,MOH,SOLS,RVTY,ETHT,CG,VNO,AMKR,FBIN,JBHT,NAIL,CRI,BXP,BMNR,LUV,BROS,OKLO,GAP,UUUU,SHAK,VST,IONZ,LGN,LSCC,FLS,CNX,AEVA,WFRD,JDST,CI,SNDK,GXO,KOLD,GNRC,DUST,BOBS,OLN,MOD,BWIN,EQPT,YSS,BRKR,MWH,FPS,HTFL,LABD,CMG,QBTZ,PLAY,CORZ,SOXL,HUT,REZI,TNDM,WERN,KNX,FLNC,ASTX,ESI,RGTZ,MKSI,ODFL,AMN,GLW,RH,KMT,OFRM,DOW,BBWI,NESR,DK,UCTT,GLXY,MUU,GDXD,USAR,SYM,RIOT,CE,XPO,NNE,WRBY,ENTG,FUN,MTSI,CIFR,SVIX,VSCO,TER,APLD,AMSC,WULF,PBF,VIAV,HYMC,JEF,GPGI,TTMI,RXO,SNXX,MOVE,ONDL,LITE,AEHR,PLTZ,GENB,WOLF,AXTI,BATL,BE
```

---

## Phone Alerts — Pushover Integration

Use the **Pushover API** (`https://api.pushover.net/1/messages.json`) for push notifications to the user's phone.

### Setup:
The user needs a free Pushover account at pushover.net. They will obtain:
- `PUSHOVER_USER_KEY` — their user key
- `PUSHOVER_APP_TOKEN` — created from the Pushover dashboard

Store both as environment variables or in a `.env` file (use `python-dotenv`).

### Alert format per tier:

**CRITICAL alert:**
```
Title: 🔴 CAPITULATION — {TICKER}
Message:
Gap Down: -{gap_pct:.1f}% | Recovery: +{recovery_pct:.1f}%
RVOL: {rvol:.1f}x | Price: ${price:.2f}
Time Weight: {time_multiplier}x | {time_str} ET
Sector: {sector}
Priority: 2 (emergency — bypasses quiet hours, requires acknowledgment)
Sound: siren
```

**HIGH alert:**
```
Title: 🟠 HIGH SETUP — {TICKER}
Priority: 1 (high — bypasses quiet hours)
Sound: pushover
```

**WATCH alert:**
```
Title: 🟡 WATCH — {TICKER}
Priority: 0 (normal)
Sound: default
```

### Deduplication:
- Track a `sent_alerts` dict keyed by `{ticker}_{tier}_{date}` 
- Only send a new alert if the ticker hasn't already been alerted at that tier today
- If a stock upgrades from WATCH → HIGH → CRITICAL, send a new alert for each tier upgrade
- Reset `sent_alerts` at midnight ET each day

### Alert rate limiting:
- Maximum 3 alerts per 60-second window to avoid Pushover throttling
- Queue excess alerts and drain the queue after the rate limit window

---

## Scanner Architecture

### File structure:
```
capitulation_scanner/
├── capitulation_scanner.py   # Main entry point
├── config.py                 # API keys, thresholds, settings
├── polygon_client.py         # All Polygon API calls (async)
├── signal_engine.py          # Gap/recovery/RVOL calculation + tier logic
├── alert_manager.py          # Pushover integration + deduplication
├── watchlist.py              # The 1,105 tickers + sector/industry metadata
└── requirements.txt
```

### Main scan loop in `capitulation_scanner.py`:
```python
async def run_scanner():
    while market_is_open():   # 09:30–16:00 ET Mon–Fri
        signals = await scan_all_tickers()
        for signal in signals:
            alert_manager.process(signal)
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)  # default: 60 seconds
```

### Market hours check:
- Only run during regular market hours: 09:30–16:00 ET, Monday–Friday
- Skip US market holidays (use the `exchange_calendars` library or hardcode NYSE holidays)
- Log "Market closed, sleeping until open..." outside market hours
- On startup before 09:30, pre-fetch all previous-close prices and average volumes so the first scan is instant

---

## Signal Calculation Details

```python
def calculate_signal(ticker, snapshot, prev_close, avg_daily_volume):
    open_price = snapshot['day']['o']
    current_price = snapshot['lastTrade']['p']  # or snapshot['min']['c']
    today_volume = snapshot['day']['v']
    
    # Gap calculation
    gap_pct = ((open_price - prev_close) / prev_close) * 100  # negative = gap down
    
    # Recovery from open
    recovery_pct = ((current_price - open_price) / open_price) * 100
    
    # Intraday RVOL (normalize for time of day)
    market_open = datetime(today, 9, 30, tzinfo=ET)
    minutes_elapsed = (now_et - market_open).seconds / 60
    expected_pct_of_day = minutes_elapsed / 390  # 390 min in trading day
    rvol = (today_volume / avg_daily_volume) / expected_pct_of_day if expected_pct_of_day > 0 else 0
    
    # Qualify
    if gap_pct <= -3.0 and recovery_pct > 0:
        tier = classify_tier(gap_pct, recovery_pct, rvol)
        time_weight = get_time_weight(now_et)
        return Signal(ticker, gap_pct, recovery_pct, rvol, tier, time_weight, current_price)
    
    return None
```

---

## Console Output

Print a live terminal table every scan cycle showing all active signals, sorted by tier then gap magnitude:

```
╔══════════════════════════════════════════════════════════════════════════╗
║           MORNING CAPITULATION SCANNER  |  10:14 ET  |  Cycle #8        ║
╠══════╦══════════╦═══════════╦════════════╦══════════╦════════╦══════════╣
║ Tier ║ Ticker   ║ Gap Down  ║ Recovery   ║ RVOL     ║ Price  ║ TimeWt   ║
╠══════╬══════════╬═══════════╬════════════╬══════════╬════════╬══════════╣
║ 🔴   ║ NVDA     ║ -10.2%    ║ +2.1%      ║ 4.2x     ║ $98.45 ║ 1.5x     ║
║ 🟠   ║ TSLA     ║ -6.8%     ║ +0.9%      ║ 2.7x     ║ $187.3 ║ 1.5x     ║
║ 🟡   ║ AMD      ║ -3.1%     ║ +0.3%      ║ 1.6x     ║ $110.2 ║ 1.5x     ║
╚══════╩══════════╩═══════════╩════════════╩══════════╩════════╩══════════╝
Scanned 1,105 tickers in 2.3s | 3 signals found | Next scan in 57s
```

---

## Configuration (`config.py`)

Make all thresholds configurable without touching main code:

```python
POLYGON_API_KEY = os.getenv("POLYGON_API_KEY")
PUSHOVER_USER_KEY = os.getenv("PUSHOVER_USER_KEY")
PUSHOVER_APP_TOKEN = os.getenv("PUSHOVER_APP_TOKEN")

SCAN_INTERVAL_SECONDS = 60

# Tier thresholds
CRITICAL_GAP = -8.0       # %
CRITICAL_RECOVERY = 1.0   # %
CRITICAL_RVOL = 3.0

HIGH_GAP = -5.0
HIGH_RECOVERY = 0.5
HIGH_RVOL = 2.0

WATCH_GAP = -3.0
WATCH_RECOVERY = 0.0
WATCH_RVOL = 1.5

# Batch size for Polygon snapshot requests
BATCH_SIZE = 250

# Max Pushover alerts per minute
ALERT_RATE_LIMIT = 3
```

---

## Requirements

Generate a `requirements.txt` with these dependencies:
```
aiohttp>=3.9.0
asyncio
python-dotenv>=1.0.0
pytz>=2024.1
rich>=13.0.0          # for beautiful console output
requests>=2.31.0      # for Pushover (sync is fine)
exchange-calendars>=4.5.0   # for NYSE holiday detection
```

---

## Error Handling

- If Polygon returns an error for a ticker, log it and skip silently — never crash the scan loop
- If Pushover fails, log the error and retry once after 5 seconds
- If the full batch scan takes longer than `SCAN_INTERVAL_SECONDS`, log a warning and start the next cycle immediately (don't double-scan)
- Wrap the entire `run_scanner()` in a top-level try/except that logs crashes and restarts the loop after 10 seconds

---

## Startup Sequence

When the script starts:
1. Print banner with version, scan interval, and watchlist size
2. Validate API keys — exit with clear error if missing
3. Check if market is open; if not, print next open time and wait
4. Pre-fetch all 1,105 previous closes + average volumes (batched, parallel)
5. Print "Pre-fetch complete. Starting scan loop..." 
6. Begin main loop

---

## Example `.env` file (include in output as `.env.example`):
```
POLYGON_API_KEY=your_polygon_api_key_here
PUSHOVER_USER_KEY=your_pushover_user_key_here
PUSHOVER_APP_TOKEN=your_pushover_app_token_here
```

---

## Deliverables

Produce all files listed in the File Structure section above. The scanner must be runnable with:
```bash
pip install -r requirements.txt
cp .env.example .env   # then fill in keys
python capitulation_scanner.py
```
