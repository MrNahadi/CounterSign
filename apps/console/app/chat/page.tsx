import type { Metadata } from "next";
import { CustomerChat } from "./customer-chat";

// The customer's side of a simulated chat with Kikapu Studio, laid out for a phone. A full-bleed
// page with no console shell: the customer never sees the merchant's inbox or what Resolve did.

export const metadata: Metadata = { title: "Chat · Kikapu Studio" };

export default function ChatPage() {
  return <CustomerChat />;
}
