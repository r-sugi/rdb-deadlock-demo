import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding...");

  await prisma.chatRoom.createMany({
    data: [
      { name: "General", description: "一般チャット" },
      { name: "Random", description: "雑談" },
      { name: "Tech", description: "技術話" },
    ],
  });

  console.log("Seed done.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
