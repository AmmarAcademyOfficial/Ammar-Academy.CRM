import type { MetadataRoute } from "next";

/** A private staff tool: keep it out of search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
