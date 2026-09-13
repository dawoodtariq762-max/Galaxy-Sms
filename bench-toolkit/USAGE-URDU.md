# pwbench — Detail Guide (Roman Urdu): Install + Har Mode + Reports + Safety

> Ye TEMPORARY testing laboratory hai — PowerX panel ka feature NAHI.
> Production DB default mein touch nahi hota (bench DB `/var/tmp/pw20/` alag file hai).
> Test khatam = `uninstall.sh` = poora lab remove.

---

## 1. INSTALL (VPS par) — 2 tareeqe

### Tareeqa A — Archive se (GitHub ke bagair)
Archive (`powerx-deploy-2026-09-10-v2.tar.gz`) VPS par upload karo (Windows CMD se, SSH ke BAHAR):
```cmd
cd %USERPROFILE%\Downloads
scp powerx-deploy-2026-09-10-v2.tar.gz root@13.140.155.71:/tmp/
```
SSH mein:
```bash
mkdir -p /tmp/pwx && tar xzf /tmp/pwx/powerx-deploy-2026-09-10-v2.tar.gz -C /tmp/pwx
sudo bash /tmp/pwx/powerx/bench-toolkit/install.sh /opt/powerx
rm -rf /tmp/pwx /tmp/powerx-deploy-*.tar.gz
```

### Tareeqa B — GitHub se (agar commits push ho chuke)
```bash
cd /opt/powerx && git pull
sudo bash /opt/powerx/bench-toolkit/install.sh /opt/powerx
```

Install ka output:
```
✓ pwbench lab installed: /opt/powerx-bench
  TOKEN (sambhal lo, har run par chahiye): <64-hex-token>
```
**TOKEN note kar lo** — har command ke sath `--token` lagta hai. Dobara dekhna ho:
```bash
sudo cat /opt/powerx-bench/bench.config.json
```

Shartein: PowerX `/opt/powerx` par installed ho, disk par kam az kam 10GB khali (`df -h /var/tmp`).

---

## 2. PEHLA RUN — selftest (zaroori, ~3 min)

```bash
cd /opt/powerx-bench
sudo ./pwbench selftest --token "<TOKEN>"
```
Kya karta hai: 100k bench DB banata hai → scoped distribution → probes → 300 synthetic SMS
(**exact audit: 300 bheje = 300 stored**) → 2-allocator race test → report.
`SELFTEST PASS ✅` aaye = lab bilkul theek. **Ye FAIL ho to aage kuch na chalana, mujhe report bhejo.**

---

## 3. HAR MODE KA COMMAND (detail)

Common: sab commands `cd /opt/powerx-bench` se, aur har ek par `--token "<TOKEN>"`.
Options `--SCALE` etc. ya env (`SCALE=S2`) dono chalte hain.

### Mode 1 — Inventory (kitne numbers par kitni speed)
```bash
sudo ./pwbench inventory --token "<T>" --SCALE S1   # 1M  (~5 min)
sudo ./pwbench inventory --token "<T>" --SCALE S2   # 5M  (~10 min)
sudo ./pwbench inventory --token "<T>" --SCALE S3   # 10M (~15 min)
sudo ./pwbench inventory --token "<T>" --SCALE S4   # 20M (~35 min, pehle disk dekho: df -h)
```
Naapta hai: browse cold/warm/cache-hit, search exact, scoped distribution (0-duplicate proof),
allocate 1k, p50/p95/p99/max, CPU/RAM/IO, event-loop lag. S5 (50M) sirf tab jab ~25GB+ disk ho.

### Mode 2 — Ingest (SAB SE ZAROORI — 10M par 42/s wale sawal ka jawab)
```bash
sudo ./pwbench ingest --token "<T>" --RATES 10,50,100,200,300 --CONNS 1,16 --SECS 45
```
- `--RATES` = SMS rates per second (comma list) · `--CONNS` = parallel connections · `--SECS` = har step kitne second
- Har step ke baad **exact audit**: jitne bheje = utne hi stored (0 lost, 0 duplicate) — report mein `Integrity: PASS`
- 1000/s tak ja sakte ho: `--RATES 500,750,1000 --SECS 20`
- Bench server elevated rate-limit ke sath boot hota hai (200/s/IP production cap test ko jhoota fail na kare)

### Mode 3 — Users (same inventory, zyada panels)
```bash
sudo ./pwbench users --token "<T>" --SCALE S3 --USERS 25,100,150,250 --SAMPLE 25
```
Realistic role-mix virtual users banata hai (managers→agents→clients), sab ek sath browse/search/dashboard.

### Mode 4 — Allocation + RACE
```bash
sudo ./pwbench allocation --token "<T>" --SCALE S2 --BATCHES 1000,10000,50000 --RACE 8
```
- Batches alag-alag size ki allocation timings
- `--RACE 8` = 8 allocators EK SATH same 5k ids par — double-allocate/ownership-steal proof
- Ownership audit: kisi ke paas bina-manager agent na ho (orphan = FAIL)

### Mode 5 — Combined (asli duniya: sab kuch ek sath)
```bash
sudo ./pwbench combined --token "<T>" --ID C1 --MINUTES 10
```
| ID | Inventory | Users | SMS/s | Alloc |
|---|---|---|---|---|
| C1 | 20M | 150 | 70 | 1k×10 |
| C2 | 20M | 150 | 150 | 1k×10 |
| C3 | 20M | 150 | 200 | 50k |
| C4 | 50M | 150 | 100 | 50k |
| C5 | 100M | — | — | **refused** (ye `extreme` mode ka kaam hai) |
Ek sath chalta hai: 150 virtual panels + synthetic SMS + periodic allocation + background export.
Live progress har minute print hota hai. 20M tak ka inventory pehle `inventory --SCALE S4` se bana lo (reuse hoga).

### Mode 6 — Burst (overload par koi message chupke se to na gaye)
```bash
sudo ./pwbench burst --token "<T>" --PROFILES 2000x1s,10000x5s,50000x30s
```
429 (graceful reject) allowed hai — lekin **accepted message ka stored hona ZAROORI**. Recovery time bhi.

### Mode 7 — Isolation (Admin-heavy vs baqi panels)
```bash
sudo ./pwbench isolation --token "<T>" --SCALE S2 --HEAVY export,alloc,search
```
Idle latencies naapta hai → phir admin ka bara operation chala kar M/A/C ki latency dobara →
**slowdown multiplier per role. PASS: ≤2×.**

### Mode 8 — Random (aapka config, random mix)
```bash
sudo ./pwbench random --token "<T>" --SCALE S3 --USERS 150 --SMS 70 --MINUTES 30 --ALLOC 1000
```
Random: search/browse/filter/dashboard/history/synthetic-SMS/allocation — sab limits ke andar.

### Mode 9 — Soak (accelerated 24 hour)
```bash
sudo ./pwbench soak --token "<T>" --SCALE S2 --HOURS 24 --COMPRESS 5
```
1 sim-hour = 5 real min → **120 minute** chalega. 3 admin shifts, mid-run SIGKILL+reboot drill,
hour-1 vs hour-24 degradation, DB/RSS growth. ** zaroori: `screen` mein chalao (neeche dekho).**

### Mode 1X — Extreme 100M-600M (bina giant insert)
```bash
sudo ./pwbench extreme --token "<T>" --SCALE 600M --SOAK_GB 10
```
Measured scale report se extrapolation + disk I/O soak. 500M/600M kabhi DB mein insert NAHI hote.

### Full suite (sab ek sath, ~1 ghanta)
```bash
sudo ./pwbench full --token "<T>"
```

---

## 4. LAMBE RUNS KE LIYE `screen` (SSH disconnect se bachao)

Soak/combined jaise lambe runs **screen mein** chalao — SSH tut jaye to bhi test zinda rahega:
```bash
sudo screen -S bench                                  # naya screen
sudo ./pwbench soak --token "<T>" ...                 # run shuru
# detach: Ctrl+A phir D        (screen chalta rahega)
# wapis aana: sudo screen -r bench
```

---

## 5. STOP / REPORT / CLEANUP / UNINSTALL

```bash
sudo ./pwbench stop --token "<T>"       # emergency STOP (sab runs agle second band)
sudo fuser -k 4888/tcp                  # agar bench server atka ho (production 4000 ko touch nahi karta)
sudo ./pwbench report --token "<T>"     # FINAL CAPACITY-ANSWER.md banata hai (sab reports se)
sudo ./pwbench cleanup --token "<T>"    # bench DBs delete (production DB SAFE)
sudo bash /opt/powerx-bench/uninstall.sh  # POORA LAB remove (reports /root/pwbench-reports-backup mein)
```

---

## 6. REPORTS — kahan aur kaise parhein

Har run ke baad: `/opt/powerx-bench/reports/<mode>-<waqt>.md` (+ .json)

Parhne ka tareeqa:
- **Verdict column:** 🟢 EASY → 🟡 WARNING → 🟠 STRESSED → 🔴 BREAKING
- **Label column:** MEASURED (is box par chala) / PROJECTED / EXTRAPOLATED / DISK-MEASURED
- **Integrity audit:** `sent == stored`, `lost=0`, `dup=0` hona chahiye — ye FAIL ho to foran mujhe bhejo
- **Bottleneck:** report ke aakhir mein auto-analysis
- **Final capacity table:** `sudo ./pwbench report --token "<T>"` → `reports/CAPACITY-ANSWER.md`

Reports apne PC par le aao:
```cmd
scp -r root@13.140.155.71:/opt/powerx-bench/reports %USERPROFILE%\Desktop\pwbench-reports
```

---

## 7. LIVE MONITOR (optional)

Doosre SSH terminal mein:
```bash
sudo node /opt/powerx-bench/monitor.js
```
Ye **sirf VPS ke localhost (4999)** par khulta hai. Apne PC browser mein dekhne ke liye SSH tunnel:
```cmd
ssh -L 4999:127.0.0.1:4999 root@13.140.155.71
```
Phir browser: `http://127.0.0.1:4999` — live CPU/RAM/WAL/EL-lag + reports list (2s refresh).

---

## 8. TROUBLESHOOTING

| Masla | Hal |
|---|---|
| `port 4888 busy` | `sudo fuser -k 4888/tcp` phir dobara |
| `REFUSED: token` | `sudo cat /opt/powerx-bench/bench.config.json` se TOKEN copy karo |
| `disk full` bench load par | `df -h /var/tmp` — purane bench DBs: `sudo ./pwbench cleanup --token "<T>"` |
| SSH tut gaya lambe run mein | Agar `screen` use kiya tha: `sudo screen -r bench`. Warna run mar gaya — dobara chalao |
| selftest FAIL | Report `/opt/powerx-bench/reports/selftest-*.md` mujhe bhejo — aage mat barho |
| Production panel slow hui test ke doran | Normal hai (disk share hota hai) — heavy tests raat ko chalao |

---

## 9. SAFETY (kaise production protected hai)

- Bench server **alag process, alag port (4888), alag DB file** (`/var/tmp/pw20/bench.db`) — production DB `/opt/powerx/data/powerx.db` ko toolkit ka koi code path touch hi nahi karta
- Bench server loopback-only target; public IP par refuse
- Caps: 180min/run, 5M msgs/run, 64 workers, 50k alloc batch
- `STOP` file kill-switch, har mode ka auto-cleanup
- Sirf **synthetic** data/traffic — koi real OTP recipient nahi, koi external system nahi
- Panel (port 4000) chalta rehta hai — tests uske sath chal sakte hain (yehi to asli isolation test hai)

## 10. MERA RECOMMENDED SEQUENCE (aapke goal ke liye)

1. `selftest` → PASS confirm
2. `ingest --RATES 10,50,100,200,300 --CONNS 1,16 --SECS 45` → **10M-par-42/s ka asli jawab** (WAL stall vs single-conn)
3. `isolation --SCALE S3` → admin-heavy proof
4. `allocation --SCALE S3 --RACE 16` → race/steal proof @10M
5. `inventory --SCALE S4` (20M, agar disk ho) → phir `combined --ID C1..C3`
6. `soak` (raat ko screen mein) → degradation check
7. `report` → CAPACITY-ANSWER mujhe bhejna
