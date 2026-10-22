import { redirect } from "next/navigation";

// The console opens on its decisions.
export default function ConsoleHome() {
  redirect("/decisions");
}
