# stripe-commerce-engine

Payments and order microservice built with NestJS, PostgreSQL (Prisma) and Stripe. The hard parts of taking money are the focus: checkout that's safe to retry, Stripe webhooks that can arrive twice or out of order, an explicit order state machine, and order events published to RabbitMQ for other services.

Work in progress: the project skeleton, Postgres via Prisma, the health check and a read-only product catalog are in.

## Catalog

Products live in Postgres with prices in the currency's smallest unit (`unitAmount: 2500` is $25.00), the same way Stripe takes them, so no float ever touches money. The API only reads the catalog. Products come from `npm run seed` for now, and the order flow will reserve stock against them.

The stock column has a `CHECK (stock >= 0)` constraint, added to the migration by hand because Prisma's schema can't express check constraints. Even if two checkouts race for the last unit, the database refuses to oversell. Responses expose `inStock` instead of the exact count.

## Tech stack

NestJS 11, TypeScript, PostgreSQL 16, Prisma 7 (with the `pg` driver adapter), Stripe, RabbitMQ, Docker.

## Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/health` | `200` when Postgres answers, `503` otherwise |
| GET | `/products?page=&limit=` | active products, newest first; `limit` up to 100 (default 20) |
| GET | `/products/:id` | one active product; `404` if it doesn't exist or is inactive, `400` for a malformed id |

## Running locally

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run migrate:deploy
npm run seed
npm run start:dev
```

`npm install` also runs `prisma generate`, which writes the typed client to `src/generated/prisma` (gitignored). After changing `prisma/schema.prisma`, run `npm run migrate:dev -- --name <change>` and then `npx prisma generate`, because Prisma 7's `migrate dev` no longer regenerates the client.

Or run everything in containers with `docker compose up --build`, after applying migrations from the host with `npm run migrate:deploy`.

## Tests

```bash
npm test
```

The e2e suite boots the real app against Postgres:

```bash
docker compose up -d postgres
npm run migrate:deploy
npm run test:e2e
```

CI runs lint, a Prettier check, the build, and both suites, with Postgres as a service container.

## License

MIT
