const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const users = await prisma.user.findMany({ take: 1 });
    console.log('✅ Database connection successful! Found users:', users.length);
  } catch (e) {
    console.error('❌ Database connection failed:', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
main();
