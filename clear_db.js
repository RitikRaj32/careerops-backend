const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearDB() {
  try {
    const { count } = await prisma.user.deleteMany({});
    console.log(`Deleted ${count} users from PostgreSQL database.`);
  } catch (e) {
    console.error('Error clearing database:', e);
  } finally {
    await prisma.$disconnect();
  }
}

clearDB();
