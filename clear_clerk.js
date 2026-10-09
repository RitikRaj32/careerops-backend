const { clerkClient } = require('@clerk/express');
require('dotenv').config();

async function clearUsers() {
  try {
    const users = await clerkClient.users.getUserList();
    console.log(`Found ${users.totalCount} users in Clerk.`);
    for (const user of users.data) {
      await clerkClient.users.deleteUser(user.id);
      console.log(`Deleted user ${user.id}`);
    }
    console.log('All Clerk users deleted.');
  } catch (error) {
    console.error('Error clearing Clerk users:', error);
  }
}

clearUsers();
