import type { MetadataRoute } from "next";

// The approvals page as a home-screen app (phase 9). No colour values: the page's own theme
// applies once it opens.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Countersign approvals",
    short_name: "Approvals",
    start_url: "/approvals",
    display: "standalone",
  };
}
