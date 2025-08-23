# Hot Health v7.2 — Full Stack Bundle

## 1) Backend
```powershell
cd backend
copy .env.example .env   # then edit .env with your values
npm install
node index.js
```

### backend/.env (example)
```env
OPENAI_API_KEY=sk-...
PORT=4000
PUBLIC_BASE_URL=http://10.0.0.125:4000
ADMIN_PASSWORD=YourStrongPassword
ENCRYPTION_KEY=
RETENTION_DAYS=0
OPENAI_TEXT_MODEL=gpt-4o
```

## 2) Frontend
```powershell
cd frontend
copy .env.example .env   # edit VITE_BACKEND_URL
npm install
npm run dev
```

Open the app: http://localhost:5173

## 3) Notes
- Use the **Target Language** dropdown before stopping recording to get dual-block on first report.
- Admin list: `http://<backend>/reports?password=YourStrongPassword`
- Each report page contains its own **Translate → New** form.
- QR opens the absolute `PUBLIC_BASE_URL` link so it works on mobile.
- PHI precautions: emails/phones/names/addresses lightly masked in transcript; PII (name/email/emergency) stored encrypted.
- Database: `data/hothealth.sqlite` (sql.js persisted file).
