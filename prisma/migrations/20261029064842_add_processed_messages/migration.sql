-- CreateTable
CREATE TABLE "processed_messages" (
    "consumer" VARCHAR(100) NOT NULL,
    "message_id" VARCHAR(255) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("consumer","message_id")
);

