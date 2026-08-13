import { authenticate } from "../shopify.server";
import { tryConnectDB } from "../db.server";
import { Session } from "../models/schemas.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    await tryConnectDB();
    await Session.updateOne(
      { _id: session.id },
      { $set: { scope: current.toString() } }
    );
  }

  return new Response();
};
