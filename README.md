# ActivationService

Verifies **physical presence** (check-ins) at a merchant/event location for WavyMania — the
foundation of the cost-per-activation business model. Core mechanic: a **rotating TOTP-based QR
code** at the location, scanned by the consumer app, backed by plausibility checks and rate
limits. Every verified check-in is stored as a **signed event**, which later feeds CPA billing
(Phase 3), reputation (immediately), and token burn (Phase 4).

> Auth-relevant service -- plan approval required before implementation (see coordination rules).

## Stack

- Node.js + Express
- MongoDB via Mongoose, Redis for rate-limiting
- JWT (RS256) verification against the AuthService public key
- `X-API-Key` auth for internal service-to-service calls

## Documentation

The full specification -- data models, endpoints, env variables, and acceptance criteria -- lives
in [ActivationService.md](./ActivationService.md).

Part of the [WavyMania](https://github.com/AdamaMX5/WavyMania) microservice ecosystem.
