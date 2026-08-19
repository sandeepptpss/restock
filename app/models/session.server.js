import { Session as ShopifySession } from "@shopify/shopify-api";
import { connectDB } from "../db.server";
import { Session } from "./schemas.server";

/**
 * MySQL implementation of Shopify's SessionStorage interface.
 *
 * Online-session user data is flattened into columns rather than nested, so an
 * online session round-trips with its `onlineAccessInfo` intact.
 */
export class MySqlSessionStorage {
  async storeSession(session) {
    await connectDB();
    await Session.updateOne(
      { _id: session.id },
      { $set: sessionToRecord(session) },
      { upsert: true }
    );
    return true;
  }

  async loadSession(id) {
    await connectDB();
    const record = await Session.findById(id).lean();
    return record ? recordToSession(record) : undefined;
  }

  async deleteSession(id) {
    await connectDB();
    await Session.deleteOne({ _id: id });
    return true;
  }

  async deleteSessions(ids) {
    await connectDB();
    await Session.deleteMany({ _id: { $in: ids } });
    return true;
  }

  async findSessionsByShop(shop) {
    await connectDB();
    const records = await Session.find({ shop }).sort({ expires: -1 }).limit(25).lean();
    return records.map(recordToSession);
  }
}

function sessionToRecord(session) {
  const params = session.toObject();
  const user = params.onlineAccessInfo?.associated_user;

  return {
    shop: session.shop,
    state: session.state,
    isOnline: session.isOnline,
    scope: session.scope || null,
    expires: session.expires || null,
    accessToken: session.accessToken || "",
    userId: user?.id ?? null,
    firstName: user?.first_name || null,
    lastName: user?.last_name || null,
    email: user?.email || null,
    accountOwner: user?.account_owner || false,
    locale: user?.locale || null,
    collaborator: user?.collaborator || false,
    emailVerified: user?.email_verified || false,
    refreshToken: params.refreshToken || null,
    refreshTokenExpires: params.refreshTokenExpires || null,
  };
}

function recordToSession(record) {
  const params = {
    id: record._id,
    shop: record.shop,
    state: record.state,
    isOnline: record.isOnline,
  };

  // Only set what is actually stored: fromPropertyArray drops null/undefined
  // entries, and passing e.g. String(null) would fabricate a "null" user.
  if (record.scope) params.scope = record.scope;
  if (record.accessToken) params.accessToken = record.accessToken;
  if (record.expires) params.expires = new Date(record.expires).getTime();
  if (record.refreshToken) params.refreshToken = record.refreshToken;
  if (record.refreshTokenExpires) {
    params.refreshTokenExpires = new Date(record.refreshTokenExpires).getTime();
  }

  if (record.userId != null) {
    params.userId = record.userId;
    if (record.firstName != null) params.firstName = record.firstName;
    if (record.lastName != null) params.lastName = record.lastName;
    if (record.email != null) params.email = record.email;
    if (record.locale != null) params.locale = record.locale;
    if (record.accountOwner != null) params.accountOwner = record.accountOwner;
    if (record.collaborator != null) params.collaborator = record.collaborator;
    if (record.emailVerified != null) params.emailVerified = record.emailVerified;
  }

  return ShopifySession.fromPropertyArray(Object.entries(params), true);
}
