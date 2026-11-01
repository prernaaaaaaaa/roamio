import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import { summary } from './memory.js';

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);

const tripSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    title: { type: String, required: true, maxlength: 120 },
    input: { type: Schema.Types.Mixed, required: true },
    result: { type: Schema.Types.Mixed, required: true },
    shareId: { type: String, unique: true, sparse: true },
  },
  { timestamps: true, minimize: false },
);

const asUser = (u) => (u ? { id: String(u._id), email: u.email, name: u.name, passwordHash: u.passwordHash, createdAt: u.createdAt } : null);
const asTrip = (t) => (t ? { id: String(t._id), userId: String(t.userId), title: t.title, input: t.input, result: t.result, shareId: t.shareId ?? null, createdAt: t.createdAt } : null);
const validId = (id) => mongoose.isValidObjectId(id);

export class MongoStore {
  constructor(uri) {
    this.kind = 'mongo';
    this.uri = uri;
    this.User = mongoose.models.User || mongoose.model('User', userSchema);
    this.Trip = mongoose.models.Trip || mongoose.model('Trip', tripSchema);
  }

  async connect() {
    await mongoose.connect(this.uri, { serverSelectionTimeoutMS: 8000 });
    await Promise.all([this.User.init(), this.Trip.init()]);
  }

  async close() {
    await mongoose.disconnect();
  }

  async createUser({ email, name, passwordHash }) {
    try {
      return asUser(await this.User.create({ email, name, passwordHash }));
    } catch (err) {
      if (err?.code === 11000) throw Object.assign(new Error('Email already registered'), { code: 'email_taken' });
      throw err;
    }
  }

  async findUserByEmail(email) {
    return asUser(await this.User.findOne({ email }).lean());
  }

  async findUserById(id) {
    return validId(id) ? asUser(await this.User.findById(id).lean()) : null;
  }

  async createTrip({ userId, title, input, result }) {
    return asTrip(await this.Trip.create({ userId, title, input, result }));
  }

  async listTrips(userId) {
    const rows = await this.Trip.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((r) => summary(asTrip(r)));
  }

  async getTrip(id, userId) {
    return validId(id) ? asTrip(await this.Trip.findOne({ _id: id, userId }).lean()) : null;
  }

  async deleteTrip(id, userId) {
    if (!validId(id)) return false;
    const r = await this.Trip.deleteOne({ _id: id, userId });
    return r.deletedCount === 1;
  }

  async setShare(id, userId, enabled) {
    if (!validId(id)) return null;
    const existing = await this.Trip.findOne({ _id: id, userId }).lean();
    if (!existing) return null;
    const shareId = enabled ? existing.shareId || nanoid(10) : null;
    const update = shareId ? { $set: { shareId } } : { $unset: { shareId: 1 } };
    return asTrip(await this.Trip.findOneAndUpdate({ _id: id, userId }, update, { new: true }).lean());
  }

  async getSharedTrip(shareId) {
    return asTrip(await this.Trip.findOne({ shareId: String(shareId) }).lean());
  }
}
