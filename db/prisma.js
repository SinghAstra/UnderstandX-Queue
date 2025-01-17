import { PrismaClient } from "@prisma/client";

const prismaGlobal = global;

const prisma =
  prismaGlobal.prisma ||
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV === "development") {
  prismaGlobal.prisma = prisma;
}

// Test connection on startup
prisma
  .$connect()
  .then(() => {
    console.log("Connected to the Database Successfully");
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
    process.exit(1);
  });

// Handle graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export default prisma;
