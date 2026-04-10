import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
}
const pool = new pg.Pool({
    connectionString,
});
const adapter = new PrismaPg(pool);
export const db = new PrismaClient({
    adapter,
});
//# sourceMappingURL=client.js.map