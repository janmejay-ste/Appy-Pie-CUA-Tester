import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cua-tester';

export async function connectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return; // already connected
  await mongoose.connect(MONGO_URI);
  console.log('[db] Connected to MongoDB at', MONGO_URI);
}
