# Environment Variables

## Portage Backend (`.env`) {#wiki-environment-variables-portage-backend-env}

```bash
BACKEND_PORT=8000
DATABASE_URL_ADMIN=mysql://user:pass@host/travel_tracker_trips
DATABASE_URL_CLIENT=mysql://user:pass@host/ez_colbert
DATABASE_PREFIX=
REDIS_HOST=localhost
REDIS_PORT=6379
KAFKA_BROKERS=localhost:9092
SKIP_MICROSERVICES=
GDIC_URL=
GDIC_TOKEN=
MAIL_DRIVER=smtp
MAIL_HOST=
MAIL_PORT=
MAIL_USERNAME=
MAIL_PASSWORD=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=travel.tracker
TWILIO_MODE=LIVE
ROLLBAR=
LEGACY_URL=                    # TravelTracker backend URL
FRONTEND_URL=http://ezat-local.transact.com
COOKIE_PREFIX=
COOKIE_DOMAIN=transact.com
```

---

## Portage Frontend (`.env`) {#wiki-environment-variables-portage-frontend-env}

```bash
ENVIRONMENT=local
NUXT_PUBLIC_API_BASE=http://ezat-local.transact.com:8000
DEV_HOST=ezat-local.transact.com
DEV_PORT=3000
LEGACY_URL=http://ezat-local.transact.com
GOOGLE_MAPS_API_KEY=
```

---

## TravelTracker (`config.json`) {#wiki-environment-variables-traveltracker-config-json}

```json
{
  "server": { "port": 8081 },
  "database": {
    "server": "127.0.0.1",
    "user": "root",
    "password": "",
    "prefix": "ez_",
    "database": "travel_tracker_trips"
  },
  "domain": "traveltrackertrips.transact.com:8081",
  "cookie": { "prefix": "ttlocal_", "domain": "transact.com" },
  "auth": { "url": "", "token": "" },
  "redis": { "host": "127.0.0.1", "port": 6379 },
  "aws": { "accessKeyId": "", "secretAccessKey": "", "s3Bucket": "travel.tracker" },
  "messaging": { "twilioSid": "", "twilioToken": "", "twilioPhone": "" },
  "newBackend": { "url": "http://ezat-local.transact.com:8000" },
  "newFrontend": { "url": "http://ezat-local.transact.com:3001" }
}
```

---

---

