import "server-only";
import { attachmentRoute } from "../../../../../src/resolve-routes";

// A customer's photo from Resolve, passed on only when it's a JPEG, PNG or WebP (ADR 0030).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/resolve/attachments/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return attachmentRoute(id, { env: process.env });
}
