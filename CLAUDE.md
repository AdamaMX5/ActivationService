# ActivationService

Verifiziert physische Anwesenheit (Check-ins) beim Händler/Event für WavyMania über rotierende
TOTP-QR-Codes — Grundlage des Cost-per-Activation-Geschäftsmodells.

> 🔐 Auth-relevant — Planfreigabe vor Implementierung (siehe Team-Koordinationsregeln).

## Architecture
See @./ActivationService.md für die eigene API Dokumentation (Datenmodelle, TOTP-Mechanik, Rate-Limits).
See @../../.claude/MSArchitecture/AuthService.md für AuthService details (JWT verification, GITCLIENT role).
See @../../.claude/MSArchitecture/ProfileService.md für ProfileService details (XP-Events bei verifiziertem Check-in).
See @../WaveService/WaveService.md für WaveService details (Stats-Update `checkins` bei Check-in im Wave-Kontext).
See @../../.claude/MSArchitecture/ExceptionService.md für ExceptionService details (Sende Fehlerfälle und Fraud-Signale).
