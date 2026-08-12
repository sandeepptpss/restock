import { PrismaClient } from "@prisma/client";

let prisma;

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal || !global.prismaGlobal.inventorySettings) {
    global.prismaGlobal = new PrismaClient();
  }
  prisma = global.prismaGlobal;
} else {
  prisma = new PrismaClient();
}

export default prisma;
