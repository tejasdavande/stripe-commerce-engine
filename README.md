# stripe-commerce-engine

Payments and order microservice built with NestJS, PostgreSQL (Prisma) and Stripe. The hard parts of taking money are the focus: checkout that's safe to retry, Stripe webhooks that can arrive twice or out of order, an explicit order state machine, and order events published to RabbitMQ for other services.

Work in progress: the project skeleton, Postgres via Prisma, the health check, a read-only product catalog, order creation with stock reservation and idempotency keys, a Stripe PaymentIntent per order, and signed, deduplicated Stripe webhooks that mark orders paid or cancel them and release their stock, a job that expires unpaid orders, and order events published to RabbitMQ through a transactional outbox are in.

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

### Idempotency

A checkout request can time out after the server has already created the order, and a client that blindly retries would then reserve stock twice. `POST /orders` accepts an optional `Idempotency-Key` header (1-255 characters, e.g. a UUID the client generates once per checkout):

- A retry with the same key and the same body returns the original order with `201` and an `Idempotent-Replayed: true` header, and doesn't touch stock again. The order is returned in its current state, so a replay after payment shows `paid`.
- Reusing a key with a different body gives `422`. The request is compared by a SHA-256 hash of the validated email and lines.
- If the request fails (`404`, `409`, `422`), the key isn't kept, so the client can fix the problem and retry with the same key.

The key row is inserted first, in the same transaction as the order. If two requests with the same key arrive at once, the second one's insert waits on the primary key until the first transaction ends. If the first committed, the second gets a unique violation, rolls back and replays the stored order. If the first rolled back, the second goes ahead as a fresh request. The e2e suite sends 10 concurrent requests with one key and expects one order, one stock reservation and nine replays.

## Payments

Every new order gets a Stripe PaymentIntent for its total, and `POST /orders` returns its `clientSecret`. The client confirms the payment with Stripe.js (Payment Element), so card details never reach this service. The intent carries the order id in its metadata, and the order stores the intent id so webhooks can find it later.

The intent is created after the order transaction commits, not inside it. Product rows stay locked until commit, so calling Stripe from inside the transaction would make every other checkout for the same product wait on Stripe's response time.

The trade-off is that Stripe can fail after the order exists. In that case `POST /orders` returns `502`, and the order stays `pending_payment` with its stock reserved but no intent. A retry with the same `Idempotency-Key` replays the order and creates the intent then. Each intent is created with the Stripe idempotency key `order-<order id>`, so two retries racing each other still get the same intent from Stripe. A replay of an order that already has an intent fetches its client secret again, and a replay of an order that's no longer awaiting payment returns no secret. `GET /orders/:id` never returns the secret.

The SDK retries network errors twice and gives up after 10 seconds. Locally and in CI the app talks to [stripe-mock](https://github.com/stripe/stripe-mock) via `STRIPE_API_URL`, so no real keys are needed. To use Stripe test mode, set your own `sk_test_` key and remove `STRIPE_API_URL`.

## Webhooks

The client confirming a payment with Stripe.js doesn't prove anything to the server, so an order only becomes `paid` when Stripe says so. Stripe calls `POST /webhooks/stripe`, and the handler:

1. Verifies the `Stripe-Signature` header against the raw request body with `STRIPE_WEBHOOK_SECRET`. The app is created with `rawBody: true` because the signature covers the exact bytes Stripe sent, and re-serialized JSON wouldn't match. A missing, forged or tampered signature, or one older than Stripe's 5-minute tolerance, gives `400`.
2. Inserts the event id into `stripe_events` and applies the event in the same transaction. Stripe delivers at least once, so the same event can arrive twice, even at the same time. A redelivery that races the first one waits on the primary key, then hits a unique violation and is acknowledged without being applied again. If applying the event fails, the event row rolls back too, the endpoint returns an error, and Stripe retries later.

Order status follows an explicit state machine:

```
pending_payment ──> paid ──> fulfilled
       │
       └──> cancelled
```

`payment_intent.succeeded` moves the order from `pending_payment` to `paid` with a conditional update (`WHERE status = 'pending_payment'`). Before that, the amount and currency received are checked against the order. A mismatch, an unknown intent or an illegal transition (say, a payment landing on a cancelled order) is logged and acknowledged, because redelivering the event wouldn't change the outcome. Refunding a payment that lands on a cancelled order is still to do. `payment_intent.payment_failed` leaves the order `pending_payment`, because the buyer can retry on the same intent with another card. `payment_intent.canceled` moves a `pending_payment` order to `cancelled` and puts each item's quantity back into stock in the same transaction. Stock is only released when that call actually moved the order, so a cancellation that arrives again under a new event id, or one that loses a race with a payment, doesn't release it twice. Product rows are updated in product id order, the same order checkout locks them in, so the two can't deadlock. Other event types are recorded and ignored. The last step, `paid` to `fulfilled`, happens through `POST /orders/:id/fulfil`, which whatever ships the order calls.

To try it against real Stripe test mode, run `stripe listen --forward-to localhost:3000/webhooks/stripe` and put the `whsec_` secret it prints into `STRIPE_WEBHOOK_SECRET`. The e2e suite signs its own events with the test secret.

## Unpaid order expiry

An abandoned checkout would otherwise hold its stock forever. Once a minute, a job (`@nestjs/schedule`) picks up to 100 `pending_payment` orders older than `ORDER_PAYMENT_TTL_MINUTES` (default 30), oldest first, and for each one:

1. Cancels its PaymentIntent at Stripe, so the buyer can no longer pay for an order that's about to be cancelled. If Stripe refuses because the intent already succeeded or is still processing, the order is left alone and the webhook settles it. An intent that was already canceled counts as cancelled.
2. Cancels the order and releases its stock in one transaction, through the same code path as the `payment_intent.canceled` webhook. That webhook arrives right after step 1 and finds the order already cancelled, so stock is released once whichever gets there first.

An order with no intent (Stripe failed during checkout) is cancelled straight away. The cancel only applies if the order still has the status and intent it was read with, so a checkout retry that attaches an intent between the read and the cancel makes the expiry back off until the next run. The other direction is covered too: a checkout retry that creates an intent for an order that has just expired gets `409`, and that intent is cancelled. A failure on one order is logged and the run moves on, and a run that's still going when the next minute starts makes that tick skip. Every step is conditional, so running several instances costs a few wasted calls but no double cancellation.

## Order events

Every status change (`order.paid`, `order.cancelled`, `order.fulfilled`) writes a row to `outbox_events` in the same transaction as the change itself, so an event exists if and only if the change committed. The payload is a snapshot of the order: id, status, email, total, currency, payment intent and line items. Rows only get written when a call actually moved the order, so a redelivered webhook or an expiry racing a cancellation produces one event, not two.

Writing to RabbitMQ directly from those transactions would break that guarantee: the publish can succeed for a change that then rolls back, or the commit can succeed and the publish fail. Instead, a relay runs every second and, in one transaction:

1. Claims up to 100 unpublished rows, oldest first, with `SELECT ... FOR UPDATE SKIP LOCKED`.
2. Publishes them to the durable `commerce.events` topic exchange on a confirm channel, with the event type as the routing key (`order.paid`, ...), the outbox row id as `messageId`, and persistent delivery, then waits for the broker to confirm every message.
3. Sets `published_at` on those rows and commits.

If RabbitMQ is down, the publish fails, the transaction rolls back, and the rows wait for the next run. Checkout and webhooks don't notice: `/health` doesn't check the broker, because the outbox is there so the API doesn't depend on it. The relay logs one warning when an outage starts and one line when it recovers, and reconnects on its own. A confirm that doesn't arrive within 10 seconds counts as a failure too.

Delivery is at least once. A crash after the broker confirms but before the commit publishes the batch again, so consumers should dedupe on `messageId`. `SKIP LOCKED` lets several app instances relay at once without waiting on each other's rows, which also means events are only ordered within one batch, not across instances. Consumers should treat the `status` in the payload as the source of truth, not the order the messages arrive in. The exchange only delivers to queues that are bound to it, so a consumer declares its own durable queue and binds it (for example to `order.#`). In compose, the RabbitMQ management UI is at http://localhost:15672 (guest/guest).

There's no auth in this service. It's meant to sit behind a gateway, and order ids are random UUIDs.

## Tech stack

NestJS 11, TypeScript, PostgreSQL 16, Prisma 7 (with the `pg` driver adapter), Stripe, `@nestjs/schedule`, RabbitMQ 4 (`amqplib`), Docker.

## Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/health` | `200` when Postgres answers, `503` otherwise |
| GET | `/products?page=&limit=` | active products, newest first; `limit` up to 100 (default 20) |
| GET | `/products/:id` | one active product; `404` if it doesn't exist or is inactive, `400` for a malformed id |
| POST | `/orders` | create an order, reserve stock and return a Stripe `clientSecret`; optional `Idempotency-Key` header; `404` unknown product, `409` not enough stock or the order expired while its intent was being created, `422` mixed currencies or a reused key with a different body, `502` Stripe unavailable (retry with the same key) |
| GET | `/orders/:id` | one order with its items; `404` if it doesn't exist |
| POST | `/orders/:id/fulfil` | mark a paid order fulfilled (called once it ships); `200` again for an already fulfilled order, `409` for any other status |
| POST | `/webhooks/stripe` | Stripe webhook receiver; `400` for a missing or invalid signature, `200` once the event is applied or was already seen |

## Running locally

```bash
cp .env.example .env
docker compose up -d postgres stripe-mock rabbitmq
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

The e2e suite boots the real app against Postgres, stripe-mock and RabbitMQ:

```bash
docker compose up -d postgres stripe-mock rabbitmq
npm run migrate:deploy
npm run test:e2e
```

CI runs lint, a Prettier check, the build, and both suites, with Postgres, stripe-mock and RabbitMQ as service containers.

## License

MIT
