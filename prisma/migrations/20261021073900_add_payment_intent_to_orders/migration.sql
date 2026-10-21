-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_intent_id" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX "orders_payment_intent_id_key" ON "orders"("payment_intent_id");

