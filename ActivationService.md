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
| `signature` | String | HMAC-SHA256 mit `CHECKIN_SIGNING_KEY` über das JSON-Array `[userId, locationId, merchantId, waveId, createdAt]` (leere Zeichenkette für fehlende `waveId`, `createdAt` als ISO-8601) — macht Abrechnungsdaten nachträglich manipulationssicher. `merchantId` ist Teil des Preimage, weil es die CPA-Auszahlung bestimmt: ohne es würde ein nachträglich auf einen anderen Händler umgebogener Check-in weiterhin als `valid` verifizieren. JSON statt Trennzeichen-Verkettung, damit die Kodierung eindeutig bleibt, auch wenn ein Feldwert je das Trennzeichen enthalten sollte |
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

---

## Implementierungsdetails

Umgesetzt in Node.js + Express + Mongoose (`src/`), Redis (`ioredis`) für Rate-Limits, siehe
[README.md](./README.md) für Setup.

- **Fehlerformat:** `{ "error": "<message>" }`; `400` Validierung (u. a. `waveId` ist strikt auf
  die Mongo-ObjectId-Form (`/^[0-9a-fA-F]{24}$/`) beschränkt, bevor es je in eine interne
  WaveService-URL oder ein XP-Event eingesetzt wird — verhindert, dass ein Client per Body-Feld
  Pfad-Traversal/Query-Injection gegen einen internen Aufruf mit ActivationServices eigenem
  `X-API-Key` erzwingt), `401` fehlender/ungültiger Token oder API-Key, `403` fehlender/ungültiger
  Bearer-Token bzw. **Merchant greift auf eine fremde Location zu** (nicht mit `404` maskiert —
  anders als bei WaveService, siehe Merchant-Tabelle), `404` Location/Check-in nicht gefunden
  (inkl. deaktivierter Locations, die für `POST /checkins` als nicht existent behandelt werden),
  `429` Rate-Limit (Cooldown/Tages-/Stunden-Cap), `500`-Interna nie im Response-Body, nur an den
  ExceptionService.
- **Ownership-Semantik:** Merchant-Routen unter `/locations/:id...` folgen strikt der eigenen
  Tabelle oben (`404` wenn die Location gar nicht existiert, `403` wenn sie existiert aber
  `merchantId !== req.user.id`) — bewusst *kein* 404-Masking wie bei WaveService, weil Merchants
  hier wissen dürfen, dass eine `id` prinzipiell existiert.
- **`totpSecret` at rest:** AES-256-GCM (`services/secretCipher.js`), 32-Byte-Schlüssel aus
  `SECRET_ENC_KEY` (Hex, 64 Zeichen), zufälliger 12-Byte-IV pro Verschlüsselung, Auth-Tag wird bei
  `decrypt` geprüft (manipulierte Ciphertext wirft). Zusätzlich zur `toJSON`-Filterung ist das Feld
  im Mongoose-Schema `select: false` — ein versehentliches `Location.find()` ohne explizites
  `.select('+totpSecret')` bekommt das Feld gar nicht erst aus der DB geladen.
- **TOTP:** `speakeasy`, 8-stellig, `window: 1` (exakt das dokumentierte ±1-Step-Fenster, nicht
  weiter). `codeStepS` ist bei Erstellung/Änderung auf 15–300s begrenzt (Schema + Validierung),
  damit ein Merchant das Fenster nicht auf einen Wert setzen kann, der die Sicherheitsannahme
  verwässert.
- **Signatur:** HMAC-SHA256 über das JSON-Array `[userId, locationId, merchantId, waveId,
  createdAt]` (siehe `Checkin`-Tabelle oben) mit `CHECKIN_SIGNING_KEY`, verifiziert per
  `crypto.timingSafeEqual` — kein naiver String-Vergleich, um Timing-Seitenkanäle bei der
  Signaturprüfung auszuschließen. Die JSON-Kodierung ist injektiv: zwei unterschiedliche
  Feldbelegungen können nicht dasselbe Preimage erzeugen, unabhängig davon, welche Zeichen die
  IDs anderer Services künftig enthalten.
- **Plausibilität:** `h3-js` `gridDistance(location.h3Cell, clientH3)`; fehlendes `clientH3` →
  `unknown`, `<= 1` → `match`, sonst (inkl. eines Fehlers bei inkompatibler/ungültiger Zelle) →
  `mismatch`. Blockiert nie den Check-in.
- **Rate-Limiter (Redis):** Cooldown per `SET ... NX EX`, Tages-/Stunden-Cap per `INCR` +
  einmaligem `EXPIRE`. Alle drei werden **vor** der TOTP-Prüfung nicht reserviert (erst danach —
  ein falscher Code verbraucht kein Kontingent) und bei einem nachgelagerten Fehler (z. B.
  fehlgeschlagenes `Checkin.create`) vollständig zurückgerollt. Eine Stunden-Cap-Überschreitung
  meldet zusätzlich ein Fraud-Signal an den ExceptionService.
- **DSGVO-Pseudonymisierung:** `GET /locations/:id/checkins` liefert statt `userId` ein
  `userRef = HMAC-SHA256(CHECKIN_SIGNING_KEY, userId)` (gekürzt) — deterministisch für
  Wiedererkennung, aber ohne den Schlüssel nicht auf die echte `userId` rückführbar.
  `GET /me/checkins` projiziert umgekehrt `signature` und `merchantId` weg — Abrechnungsdaten
  gehören nicht in die konsumentenseitige Historie.
- **Folgeaktionen** (`services/profileEvents.js`, `services/waveStats.js`): 3 Versuche,
  exponentielles Backoff, nie awaited von der Route — ein Ausfall von ProfileService/WaveService
  blockiert nie die Check-in-Response.
- **Tests:** `tests/unit/**` (TOTP-Fenstergrenzen, Signatur-Sign/Verify/Tamper, Plausibilitäts-
  Logik) und `tests/integration/**` (End-to-End über `supertest` + `mongodb-memory-server` +
  `ioredis-mock`, deckt alle 6 Akzeptanzkriterien in nummerierten `describe`-Blöcken ab, plus eine
  eigene Suite für `totpSecret`-Leck-Freiheit über jeden Lesepfad inkl. Konsolen-Ausgaben).
