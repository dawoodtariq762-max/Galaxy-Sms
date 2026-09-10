# MS SMS SERVICE — Backend API

Multi-Level SMS Panel ka real backend: **Node.js + Express + SQLite (sql.js)**
JWT authentication, role-based access, aur poori hierarchy (Admin › Manager › Agent › Client).

---

## 🚀 Chalane ka tareeqa (Local / Sandbox)

```bash
cd backend
npm install          # ek dafa (express, bcryptjs, jsonwebtoken, cors, sql.js)
node server.js       # http://localhost:4000
```

Pehli baar chalne par database (`data.sqlite`) automatically ban jaata hai aur demo data seed ho jaata hai.

Database reset karna ho to:
```bash
rm data.sqlite && node server.js
```

---

## 🔑 Demo Login Credentials

| Role    | Username  | Password    |
|---------|-----------|-------------|
| Admin   | admin     | admin123    |
| Manager | manager   | manager123  |
| Manager | sana      | sana123     |
| Agent   | agent     | agent123    |
| Client  | client    | client123   |

---

## 📡 API Endpoints (sab `/api/...`)

**Auth**
- `POST /api/login` `{username,password}` → `{token, user}`
- `GET  /api/me` (token required)

**Users** (hierarchy-scoped)
- `GET    /api/users/:role` — manager|agent|client (apne downstream)
- `POST   /api/users` — admin→manager, manager→agent, agent→client
- `PUT    /api/users/:id` , `DELETE /api/users/:id`

**Ranges / Rates** (rate set sirf admin)
- `GET /api/ranges` · `POST /api/ranges` (admin) · `PUT/DELETE /api/ranges/:id` (admin)

**Numbers**
- `GET  /api/numbers` — apne level ke numbers
- `POST /api/numbers/allocate` `{ids[],target_id,payterm,payout}`
- `POST /api/numbers/unallocate` `{ids[]}`
- `POST /api/numbers/smart-divide` `{range_ids[],target_ids[],qty}` — unallocated ko barabar baant deta hai

**SMS / CDR Stats**
- `GET /api/sms` — apne received SMS records
- `GET /api/stats/:by` — client|agent|manager|range|number (totals + payment)

**Baaki**
- `GET /api/payments`
- `GET/POST/DELETE /api/cli-limits` (POST/DELETE admin; manager ko sirf apni + overall dikhti hain)
- `GET/POST/DELETE /api/news` (POST/DELETE admin; baaki role-wise feed)
- `POST /api/webhook/sms` `{number,cli,message}` — carrier/provider incoming SMS (number→owner map)

Sab protected endpoints par header chahiye:
```
Authorization: Bearer <token>
```

---

## 🔒 Security & Rules (jaise architecture mein tha)
- Passwords **bcrypt** se hashed (plain text kabhi save nahi hote)
- **JWT** token (12h) — har request verify hoti hai
- **Hierarchy scoping**: har user sirf apna downstream data dekhta hai
- **Rate management** sirf Admin (Manager view-only)
- **Allocation** ek level neeche: Admin→Manager, Manager→Agent, Agent→Client
- Account **disabled** ho to login block

---

## 🌐 Production (VPS) par MySQL par switch

Ye sandbox mein SQLite (sql.js) use karta hai — koi native build nahi chahiye.
VPS par MySQL ke liye:

1. `npm install mysql2`
2. `db.js` ko MySQL connection se replace karein (SQL queries already portable hain — `datetime('now')` ko MySQL mein `NOW()` kar dein aur `AUTOINCREMENT` → `AUTO_INCREMENT`).
3. `.env` mein `JWT_SECRET`, DB credentials set karein.
4. `pm2 start server.js` se 24/7 chalayein (reverse proxy: Nginx).

Frontend panels (login/admin/manager/agent/client `.html`) isi server se serve hote hain
(`express.static` parent folder). Deploy ke waqt sab ek saath upload karein.

---

## 🔗 Frontend ko is API se jodना (agla step)
Abhi panels demo (dummy JS data) par chalte hain. Inhe live API se jodne ke liye
har panel mein `fetch('/api/...')` calls add karni hongi (login token localStorage se).
Ye Phase 2 ka doosra hissa hai — bata dein to shuru karun.
