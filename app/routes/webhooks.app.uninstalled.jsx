import { authenticate } from "../shopify.server";
import { tryConnectDB } from "../db.server";
import { Session } from "../models/schemas.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await tryConnectDB();
    await Session.deleteMany({ shop });
  }

  return new Response();
};
