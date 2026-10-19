# stripe-commerce-engine

Payments and order microservice built with NestJS, PostgreSQL (Prisma) and Stripe. The hard parts of taking money are the focus: checkout that's safe to retry, Stripe webhooks that can arrive twice or out of order, an explicit order state machine, and order events published to RabbitMQ for other services.

Work in progress: the project skeleton, Postgres via Prisma, the health check, a read-only product catalog and order creation with stock reservation are in. Stripe payments come next.

## Catalog

Products live in Postgres with prices in the currency's smallest unit (`unitAmount: 2500` is $25.00), the same way Stripe takes them, so no float ever touches money. The API only reads the catalog. Products come from `npm run seed` for now, and the order flow will reserve stock against them.

The stock column has a `CHECK (stock >= 0)` constraint, added to the migration by hand because Prisma's schema can't express check constraints. Even if two checkouts race for the last unit, the database refuses to oversell. Responses expose `inStock` instead of the exact count.

## Orders

`POST /orders` takes an email and a list of `{ productId, quantity }` lines. The client never sends prices: anything like `unitAmount` in the body is stripped by validation, and each line is priced from the catalog. The order stores a snapshot of each product's sku, name and price, so later catalog changes don't rewrite past orders.

Everything happens in one Postgres transaction:

1. Duplicate lines for the same product are merged, and lines are sorted by product id.
2. The products are loaded. An unknown or inactive product gives `404`, and mixing currencies in one order gives `422`.
3. Stock is reserved per line with a guarded update, `UPDATE products SET stock = stock - n WHERE id = ? AND active AND stock >= n`. If any line can't be reserved, the request fails with `409` and the whole transaction rolls back, including the lines already reserved.
4. The order is created as `pending_payment` with its items and total.

The guarded update means two checkouts racing for the last unit can't both win. The row lock makes the second one wait, and once the first commits, its `stock >= n` check fails. The e2e suite fires 10 concurrent orders at a product with 3 in stock and expects exactly 3 to succeed. Sorting the lines makes concurrent multi-item orders lock rows in the same order, so they can't deadlock.

There's no auth in this service. It's meant to sit behind a gateway, and order ids are random UUIDs.

## Tech stack

NestJS 11, TypeScript, PostgreSQL 16, Prisma 7 (with the `pg` driver adapter), Stripe, RabbitMQ, Docker.

## Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/health` | `200` when Postgres answers, `503` otherwise |
| GET | `/products?page=&limit=` | active products, newest first; `limit` up to 100 (default 20) |
| GET | `/products/:id` | one active product; `404` if it doesn't exist or is inactive, `400` for a malformed id |
| POST | `/orders` | create an order and reserve stock; `404` unknown product, `409` not enough stock, `422` mixed currencies |
| GET | `/orders/:id` | one order with its items; `404` if it doesn't exist |

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
