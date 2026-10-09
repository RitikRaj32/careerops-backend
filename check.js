const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function checkUser() {
  const user = await prisma.user.findFirst({ where: { email: 'bhoiritikkumar140@gmail.com' } });
  console.log(user);
  await prisma.$disconnect();
}
checkUser();
