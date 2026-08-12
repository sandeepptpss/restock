-- CreateTable
CREATE TABLE "InventorySettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "defaultLowStockLimit" INTEGER NOT NULL DEFAULT 5,
    "visibilityMode" TEXT NOT NULL DEFAULT 'DRAFT',
    "variantStrategy" TEXT NOT NULL DEFAULT 'HIDE_ALL_OOS',
    "locationStrategy" TEXT NOT NULL DEFAULT 'ALL_LOCATIONS',
    "restockDelayValue" INTEGER NOT NULL DEFAULT 0,
    "restockDelayUnit" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "enableAutoFill" BOOLEAN NOT NULL DEFAULT false,
    "autoFillQuantity" INTEGER NOT NULL DEFAULT 10,
    "enableAutoHide" BOOLEAN NOT NULL DEFAULT true,
    "enableAutoTag" BOOLEAN NOT NULL DEFAULT true,
    "outOfStockTag" TEXT NOT NULL DEFAULT 'out-of-stock',
    "lowStockTag" TEXT NOT NULL DEFAULT 'low-stock',
    "enableAutoPublish" BOOLEAN NOT NULL DEFAULT true,
    "enableCollectionAction" BOOLEAN NOT NULL DEFAULT false,
    "outOfStockCollectionId" TEXT,
    "removeFromCollectionId" TEXT,
    "enableEmailAlerts" BOOLEAN NOT NULL DEFAULT true,
    "alertEmail" TEXT,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "targetStockDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductThreshold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "minThreshold" INTEGER NOT NULL DEFAULT 5,
    "customReorderQty" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'inventory_levels/update',
    "conditions" TEXT NOT NULL,
    "actions" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "locationId" TEXT,
    "oldQuantity" INTEGER,
    "newQuantity" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'STOCKOUT',
    "webhookId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AutomationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "ruleId" TEXT,
    "eventType" TEXT NOT NULL DEFAULT 'INFO',
    "productId" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "actionTaken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'PRO',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScheduledRestock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT,
    "targetQuantity" INTEGER NOT NULL DEFAULT 10,
    "scheduledAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "InventorySettings_shop_key" ON "InventorySettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductThreshold_shop_productId_variantId_key" ON "ProductThreshold"("shop", "productId", "variantId");

-- CreateIndex
CREATE INDEX "AutomationRule_shop_idx" ON "AutomationRule"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEvent_webhookId_key" ON "InventoryEvent"("webhookId");

-- CreateIndex
CREATE INDEX "InventoryEvent_shop_inventoryItemId_idx" ON "InventoryEvent"("shop", "inventoryItemId");

-- CreateIndex
CREATE INDEX "AutomationLog_shop_productId_idx" ON "AutomationLog"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shop_key" ON "Subscription"("shop");

-- CreateIndex
CREATE INDEX "ScheduledRestock_shop_status_scheduledAt_idx" ON "ScheduledRestock"("shop", "status", "scheduledAt");

