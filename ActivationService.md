# ActivationService

> Base URL: `https://activation.<wavy-domain>` · Phase 1 (MVP) · 🔐 **auth-relevant → Planfreigabe vor Implementierung**

Verifiziert **physische Anwesenheit** (Check-ins) beim Händler/Event — die Grundlage des
Cost-per-Activation-Geschäftsmodells. Kernmechanik: **rotierender QR-Code** am Standort
(TOTP-basiert), gescannt von der Konsumenten-App, plus Plausibilitätschecks und Rate-Limits.
Jeder verifizierte Check-in wird als **signiertes Event** gespeichert — daran hängen später
CPA-Abrechnung (Phase 3), Reputation (sofort) und Token-Burn (Phase 4).

**Datenmodell `Location`:**

| Feld | Typ | Description |
|------|-----|-------------|
| `id` | String | Dokument-ID |
| `merchantId` | String | JWT `sub` des Inhabers (Rolle `merchant` oder `organizer`) |
| `name` | String | z. B. „Café Milchbart, Theke" |
| `lat` / `lng` / `h3Cell` | Number/String | Standort (Geschäftsdaten); `h3Cell` Res 9 serverseitig berechnen |
| `totpSecret` | String | Base32, serverseitig generiert (`speakeasy`), **nie im Klartext loggen**; verschlüsselt at rest (AES-256-GCM mit `SECRET_ENC_KEY`) |
| `codeStepS` | Number | TOTP-Fenster, default 60 |
| `active` | Boolean | deaktivierte Locations verweigern Codes und Check-ins |
| `createdAt` | Date | Auto |

**Datenmodell `Checkin`:**

| Feld | Typ | Description |
|------|-----|-------------|
| `id` | String | Dokument-ID |
| `userId` | String | JWT `sub` |
| `locationId` / `merchantId` | String | Referenzen (merchantId denormalisiert für Abrechnung) |
| `waveId` | String | optional — Check-in im Kontext einer Wave |
| `clientH3` | String | vom Client gemeldete Zelle (nur Plausibilität, kein Beweis) |
| `plausibility` | String | Enum: `match` (clientH3 ≤ 1 Ring von location.h3Cell), `mismatch`, `unknown` (Client ohne GPS) |
| `signature` | String | HMAC-SHA256 über `userId|locationId|waveId|createdAt` mit `CHECKIN_SIGNING_KEY` — macht Abrechnungsdaten nachträglich manipulationssicher |
| `createdAt` | Date | Auto |

**Check-in-QR:** Das Händler-Frontend (WavyBusiness, Tablet an der Theke) pollt
`GET /locations/:id/code` und rendert den Inhalt `wavy://checkin/<locationId>/<code>` als QR.
`code` = 8-stelliger TOTP (Step aus `codeStepS`). Bei der Validierung Fenster ±1 Step
akzeptieren (Uhren-Drift).

**Rate-Limits (Redis):**

- pro User + Location: 1 Check-in pro `CHECKIN_COOLDOWN_H` (default 4 h) → `429`
- pro User global: max. 20 Check-ins/Tag → `429`
- pro Location: max. `LOCATION_HOURLY_CAP` (default 300) Check-ins/h → `429`
  (Schutz vor Code-Weitergabe in Telegram-Gruppen; Überschreitung zusätzlich an
  ExceptionService melden — Fraud-Signal)

**Folgeaktionen nach erfolgreichem Check-in** (fire-and-forget mit Retry, nie blockierend):

1. ProfileService `POST /internal/xp-events` → `{ type: "checkin", userId, waveId? }`
2. Bei `waveId`: WaveService `POST /internal/waves/:id/stats` → `{ field: "checkins", delta: 1 }`

---

## Merchant (Bearer JWT, Rolle `merchant`/`organizer`; nur eigene Locations, sonst `403`)

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/locations` | `{ name*, lat*, lng* }` | Location anlegen; generiert `totpSecret` → `201` (Secret wird **nie** zurückgegeben) |
| `GET` | `/locations` | — | Eigene Locations |
| `PATCH` | `/locations/:id` | `{ name?, active?, codeStepS? }` | Ändern |
| `POST` | `/locations/:id/rotate-secret` | — | Neues TOTP-Secret (bei Verdacht auf Leak) |
| `GET` | `/locations/:id/code` | — | `{ code, expiresInS }` — aktueller Code fürs QR-Display; kein Cache |
| `GET` | `/locations/:id/checkins` | `?from&to&page&limit` | Check-ins der Location (ohne `userId` im Klartext — nur pseudonymisierter Hash `userRef`, DSGVO) |

## User (Bearer JWT)

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/checkins` | `{ locationId*, code*, h3?, waveId? }` | Check-in: TOTP validieren (±1 Step), Rate-Limits prüfen, Plausibilität bestimmen, Event signieren → `201` `{ id, plausibility, createdAt }`. Falscher Code → `403`; inaktive Location → `404` |
| `GET` | `/me/checkins` | `?page&limit` | Eigene Check-in-Historie |

## Internal (X-API-Key)

| Method | Endpoint | Query | Description |
|--------|----------|-------|-------------|
| `GET` | `/internal/checkins` | `?merchantId&waveId&from&to&page&limit` | Abrechnungsdaten inkl. `signature` — Konsument: künftiges Billing (Phase 3) |
| `POST` | `/internal/verify-signature` | `{ checkinId }` | Signatur eines gespeicherten Check-ins nachprüfen → `{ valid }` |

## Admin (JWT Rolle `admin`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/fraud-report` | Auffälligkeiten: Locations über Hourly-Cap, Users am Tageslimit, `mismatch`-Quoten je Location |

---

## Env (zusätzlich zur Basis)

```
REDIS_URL
SECRET_ENC_KEY              # AES-256-GCM für totpSecret at rest
CHECKIN_SIGNING_KEY         # HMAC für Checkin-Signaturen
CHECKIN_COOLDOWN_H=4
LOCATION_HOURLY_CAP=300
PROFILE_SERVICE_URL / PROFILE_SERVICE_API_KEY
WAVE_SERVICE_URL / WAVE_SERVICE_API_KEY
```

## Akzeptanzkriterien (Test-Experte)

1. Gültiger TOTP im Fenster ±1 → `201`; abgelaufener (−2 Steps) oder falscher Code → `403`
2. Zweiter Check-in desselben Users an derselben Location innerhalb Cooldown → `429`
3. `clientH3` direkt an der Location → `match`; 3 Ringe entfernt → `mismatch`; fehlend → `unknown` — alle drei Fälle erzeugen den Check-in (Plausibilität ist Datenpunkt, kein Blocker)
4. Location-Cap: 301. Check-in in einer Stunde → `429` + ExceptionService-Meldung
5. `verify-signature` erkennt ein nachträglich in der DB verändertes `waveId`-Feld als `valid: false`
6. `totpSecret` taucht in keiner API-Response und keinem Log auf
