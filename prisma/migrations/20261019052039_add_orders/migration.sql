-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending_payment', 'paid', 'fulfilled', 'cancelled');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending_payment',
    "currency" CHAR(3) NOT NULL,
    "total_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_product_id_key" ON "order_items"("order_id", "product_id");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- prisma can't express check constraints, so these are added by hand
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_amount_check" CHECK ("total_amount" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_amount_check" CHECK ("unit_amount" >= 0);
