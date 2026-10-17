# stripe-commerce-engine

Payments and order microservice built with NestJS, PostgreSQL (Prisma) and Stripe. The hard parts of taking money are the focus: checkout that's safe to retry, Stripe webhooks that can arrive twice or out of order, an explicit order state machine, and order events published to RabbitMQ for other services.

Work in progress: the project skeleton, Postgres via Prisma and the health check are in.

## Tech stack

NestJS 11, TypeScript, PostgreSQL 16, Prisma 7 (with the `pg` driver adapter), Stripe, RabbitMQ, Docker.

## Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/health` | `200` when Postgres answers, `503` otherwise |

## Running locally

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run start:dev
```

`npm install` also runs `prisma generate`, which writes the typed client to `src/generated/prisma` (gitignored).

Or run everything in containers with `docker compose up --build`.

## Tests

```bash
npm test
```

The e2e suite boots the real app against Postgres:

```bash
docker compose up -d postgres
npm run test:e2e
```

CI runs lint, a Prettier check, the build, and both suites, with Postgres as a service container.

## License

MIT
