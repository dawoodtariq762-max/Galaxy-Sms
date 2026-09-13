# GALAXY SMS — SMPP Guide (Simple)
**Provider ko Galaxy SMS se connect karna — step by step (Roman Urdu + English)**

---

## 1. SMPP kya hai?

**SMPP** (Short Message Peer-to-Peer) wo zuban hai jis se SMS providers (aggregators/carriers) aapke system se baat karte hain. Aapka panel **SMPP client** ban kar provider ke **SMPP server** se connect hota hai — jaise WhatsApp kisi server se connect hota hai.

Simple words: **Provider aapko pipe deta hai, us pipe se SMS aapke panel mein aate hain.**

Galaxy SMS mein 3 tarah ke SMS channels hain (sab ka result same — SMS panel mein dikhta hai):
1. **HTTP webhook** — provider URL par SMS POST karta hai (sab se common)
2. **HTTP pull** — panel khud provider ki API se SMS uthata hai
3. **SMPP client** — provider ke SMPP server se permanent connection

---

## 2. Provider se kya cheezein mangni hain?

Jab SMPP provider se deal karein to us se ye 6 cheezein likhwa kar lein:

| # | Cheez | Example | Kahan dalna hai (Galaxy SMS) |
|---|---|---|---|
| 1 | **Host** | `smpp.provider.com` ya IP | SMPP connection form → Host |
| 2 | **Port** | `2775` (common) ya `8775` | Port field |
| 3 | **System ID** (username) | `galaxy_sms_01` | System ID / Username |
| 4 | **Password** | `********` | Password field |
| 5 | **Bind Type** | `transceiver` (bhejna + lena dono) | Bind Type select |
| 6 | **TON / NPI** (agar zaroori ho) | TON=1, NPI=1 | Agar provider dega to batayenge, warna default theek hai |

⚠️ **Password kabhi screenshot/doc mein paste na karein.**

### Bind Type ka matlab (simple):
- **Transceiver** = SMS bhej bhi sakta hai, receive bhi (99% cases yehi)
- **Receiver** = sirf SMS receive (inbound numbers ke liye)
- **Transmitter** = sirf SMS send (humein inbound chahiye, is liye rare)

### Inbound numbers ke liye kya hoga?
Provider ko batayein: *"Humein inbound SMS chahiye — bind transceiver/receiver, aap `deliver_sm` hamare System ID par bhejein."* Provider routing set kar dega. Galaxy SMS automatically:
- `deliver_sm` **aur** `data_sm` dono accept karta hai
- **DLR (delivery receipts)** ko alag pehchan-ta hai — ye human SMS nahi hote, panel mein count nahi hote (galat data nahi banta)

---

## 3. Galaxy SMS mein connection kaise banate hain?

1. Login karein → **Management panel** (super admin)
2. **SMPP Connections** page kholein
3. **Add Connection** → Provider ke 4 values dalein: Host, Port, System ID, Password
4. **Bind Type**: `transceiver` (ya jo provider ne kaha)
5. Save → panel khud connect hoga (auto-reconnect built-in hai)
6. Status check: connection list mein **Bound** (green) dikhna chahiye — "Down" ho to values ya provider-side routing check karein

**Connection ka status:**
- `Bound` = connected, SMS aa rahe hain ✓
- `Down` = connect nahi hua (host/port/ID/password ya provider firewall)

---

## 4. Provider ne kya ensure karna chahiye? (checklist)

- [ ] Inbound SMS routing aapke System ID par (deliver_sm)
- [ ] Throttle/rate limits likh kar di hain (kitne SMS/sec accept karenge)
- [ ] Firewall unka port aapke server IP ke liye khula hai
- [ ] Test numbers diye (2-3) end-to-end verification ke liye
- [ ] DLR sirf tab agar aapko delivery status store karna ho (abhi off hai)

---

## 5. Security notes

- Password sirf connection form mein — kisi email/screenshot/doc mein NAHI
- SMPP connection sirf provider se server-to-server hota hai — panel internet par SMPP port expose NAHI karta
- Ek provider ka masla doosre provider/panel ko effect nahi karta (isolation built-in)

---

## 6. Aksar poochay jane wale sawal

**Q: Kya mujhe SMPP ki zaroorat hi hai?**
Agar provider HTTP webhook de raha hai to nahi. SMPP tab useful hai jab provider sirf SMPP de ya high-volume stable pipe chahiye.

**Q: SMPP Server mode kya hai? (carrier humse connect ho)**
Galaxy SMS mein SMPP **server** mode filhal disabled hai (sirf client active). Agar kabhi carrier aapke server par bind karna chahen to ye alag architecture decision hogi — pehle approval se.

**Q: SMS aa raha hai magar panel mein nahi dikh raha?**
1) Connection "Bound" hai? 2) Provider ne routing di? 3) Panel ke System Logs page par SMPP events dekhein (har connect/disconnect/inbound log hota hai).
